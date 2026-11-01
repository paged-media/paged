# ADR 622 — Word comments carry an author identity and an exact UTC time

- **Status:** Accepted 2026-11-01. Extends ADR 613 (review markup) toward engine ADR 1055 (one comment model).
- **Scope:** `docx-import` (`comments.rs`), `docx-core` (`Comment`), `docx-lower` (`LoweredComment`),
  `docx-export` (`review.rs`, `CommentContentIn`).
- **Builds on:** doc ADR 613; engine ADR 1055.

## Context

ADR 613 reads and writes `comments.xml`, `commentsExtended.xml` and `commentsIds.xml`. Word also
writes `people.xml` (the author's account) and `commentsExtensible.xml` (the exact UTC time).
Evidence: a document authored in Word for Mac through its AppleScript (a comment, a second
comment, a reply request, a resolve request, an `@Name` in the text) and unzipped.

## What Word writes (observed)

- Parts, each with a relationship from `word/_rels/document.xml.rels` and a content-type override:
  `people.xml` (`.../2011/relationships/people`, `...wordprocessingml.people+xml`),
  `commentsExtensible.xml` (`.../2018/08/relationships/commentsExtensible`,
  `...wordprocessingml.commentsExtensible+xml`), plus the three ADR 613 parts.
- `people.xml`: `<w15:people>` with one `<w15:person w15:author="NAME"><w15:presenceInfo
  w15:providerId="AD" w15:userId="S::mail::guid"/></w15:person>` per author (`None` and the author's
  name for an account Word cannot name).
- `commentsExtensible.xml`: `<w16cex:commentsExtensible>` with one `<w16cex:commentExtensible
  w16cex:durableId="XXXXXXXX" w16cex:dateUtc="2026-11-01T19:11:00Z"/>` per comment; `durableId` is
  the one in `commentsIds.xml`.
- `w:comment/@w:date` is the author's LOCAL time written with a `Z` (20:11 beside a `dateUtc` of
  19:11 in a UTC+1 zone). `dateUtc` is the true time and wins.
- `commentsExtended.xml`: `<w15:commentEx w15:paraId="…" w15:done="0"/>` per comment.
- A mention is only `@Name` in the comment's run text as far as Word's AppleScript can make one;
  the scripting surface cannot create a real mention, a reply or a resolved thread (the calls
  succeed and do nothing), so no mention marker is evidenced and none is modelled.

## Decision

- Read: `Comment.date_utc` from `commentsExtensible.xml` (joined by `durableId`), `Comment.user_id` and
  `Comment.provider_id` from `people.xml` (joined by author name). `LoweredComment` carries them; the
  host maps them onto the engine's `Person` (`user_id`, `provider_id`) and the comment's times.
  `date` stays the raw `w:date`.
- Write (`save_comments`, only when the comments changed): `people.xml` gets one entry per author not
  yet in it (the host's `user_id` and `provider_id`, else provider `None` and the author's name);
  `commentsExtensible.xml` gets an entry per comment made in paged, with `date_utc` or a UTC (`Z`)
  `date`. Word's own entries, and the parts when nothing changed, stay byte-identical.
- Not done: mentions.

## Word's reading (oracle)

Word 16 opens the saved files (people.xml and commentsExtensible.xml included) with no repair prompt and
reads the comment, reply, author and date (`review.word.json`). Through AppleScript the date it
reports (`date value`) follows `w:date`, not `dateUtc`: a file whose `dateUtc` was changed by five
hours reported the `w:date` time. Whether the Word UI prefers `dateUtc` is not observable from the
scripting surface, so paged writes `w:date` and `dateUtc` to the same UTC time for its own comments.

## Evidence

- `docx-conformance/tests/it/review.rs::a_first_comment_makes_the_comment_parts__feat__plugin_doc_save_back`.
- Word's reading of the saved files: `scripts/word-review-probe.sh`, `fixtures/review.word.json`.
