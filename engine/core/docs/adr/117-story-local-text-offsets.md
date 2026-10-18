# ADR 117 — Text is addressed by story-local offsets: bytes for edits, characters for ranges

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `9f933f1`.
- **Scope:** text addresses in `crates/paged-wire` and `crates/paged-canvas` (`selection.rs`, `mutate.rs`, `geometry.rs`, `channel.rs`); the range operations in `crates/paged-mutate/src/apply`

## Context

A caret, a selection and a text edit each need an address that both sides of the message
channel agree on. The engine made that address a position in the content, not on the
page: a selection "references characters in a story, not pixels on a page — so it survives
re-layout, zoom changes, frame moves, and pagination shifts"
(`crates/paged-canvas/src/selection.rs:23-27`).

Table-cell text is stored apart from the story's own paragraphs, so an address also has
to say which paragraph stream it indexes (`crates/paged-wire/src/lib.rs:542-544`).

Why the unit is the UTF-8 byte, and not the character or the UTF-16 code unit:
The repository does not record why.

## Decision

Positions for editing, selection and caret queries are story-local UTF-8 byte offsets
under one contract; text in a table cell is addressed by the same contract plus a cell
qualifier.

- **The contract.** An offset counts the bytes of each paragraph's concatenated run text,
  plus one synthetic `\n` per boundary between paragraphs. `start == end` is a caret.
- **Affinity.** One `bool` separates the two visual positions that share an offset at a
  line break: end of the line (`false`, the default) or start of the next (`true`).
- **Cells.** `cell: Option<TextCellAddr {table_id, row, col}>`. Absent, offsets index the
  story body. Present, they are cell-local under the same contract. The qualifier is the
  one a hit test returns.
- **Bad offsets.** A text edit whose offset is past the end, or inside a multi-byte
  character, is refused with a typed error (`OffsetOutOfRange`, `NotCharBoundary`).
- **Who uses it.** `InsertText`, `DeleteRange`, `ContentSelection`, the hit result's
  `offset_within_story`, and the caret, line, word and paragraph queries.

The range operations do not use this contract. `ApplyStyle`, `InsertHyperlink`,
`InsertAnchoredFrame`, `SetFieldValue` and an `ElementId::StoryRange` address count
characters over run text only, with no break character between paragraphs. For
`StoryRange` the comment calls this "IDML's native convention"
(`crates/paged-mutate/src/operation.rs:97-99`).

## Evidence

- `crates/paged-canvas/src/selection.rs:31-38` — the story-offset contract; `:40-52` affinity
- `crates/paged-wire/src/lib.rs:540-558` — the two paragraph streams and the cell qualifier; `:561-573` why not one flat offset
- `crates/paged-canvas/src/mutate.rs:749-764` — `locate` walks byte lengths; `:106-119`, `:212-225` the two refusals; `crates/paged-canvas/tests/it/utf8_offsets.rs:19-23` the test's statement of the rule
- `crates/paged-canvas/src/channel.rs:877-879`, `:895-899` — the queries share one byte address space with `HitResult.offset_within_story`
- `crates/paged-mutate/src/operation.rs:92-101` — `StoryRange`: "Offsets are character indices in the story"; `crates/paged-mutate/src/apply/paragraph.rs:87-88` "the paragraph break is not a character here"
- `crates/paged-wire/src/lib.rs:692-694` — `InsertHyperlink`: "contiguous char offsets, the `ApplyStyle` address space"; `crates/paged-mutate/src/apply/anchored_frame.rs:41-46` "deliberately NOT" the byte space
- `crates/paged-canvas/src/model.rs:476-494`, `:3694-3712` — `StoryRange` and `ApplyStyle` offsets pass to the operation unconverted
- `crates/paged-canvas/tests/it/apply_style_caret.rs:25-27` — a test written in the character space

## Alternatives considered

One flat story-offset space with a reserved region for cells "was rejected": every
consumer of body offsets would have to learn the encoding, "and a single arithmetic slip
silently routes an edit into the wrong cell" (`crates/paged-wire/src/lib.rs:563-569`).

## Consequences

A content address stays valid across layout changes, but only until the next edit of that
stream; the engine shifts its own stored selection after an insert or delete.

Two units are on the wire. For ASCII text in one paragraph the two spaces agree; they
differ by one per paragraph boundary and by the extra bytes of every non-ASCII character.
A caller that selects a range by caret queries and then styles it must convert. The
message channel has no conversion request, and no code in `paged-canvas`, `paged-wire`,
`paged-introspect` or `paged-script` mentions UTF-16, so a JavaScript host converts its
string indices itself.

Inside the model, the anchor of an anchored frame is a character offset within its
paragraph (`crates/paged-model/src/lib.rs:4898-4907`).

Places where the code or its descriptions disagree with the contract:

- After `InsertText`, the model shifts its stored selection by the inserted text's
  character count, not its byte length (`crates/paged-canvas/src/model.rs:2276`).
- The capability catalogue describes a story as "Edited by character offset, not by
  frame" (`crates/paged-introspect/src/catalog.rs:976`).
- `crates/paged-canvas/src/selection.rs:37` names `paged_mutate::text_index` as a consumer;
  no such module exists.

## Related

- [ADR 114](114-interaction-lives-in-the-engine.md) — the selection and caret queries that carry these offsets
- [ADR 116](116-mutations-lowered-onto-operations.md), [ADR 110](110-one-undo-timeline.md) — the text lane and its inverses
- [ADR 111](111-wire-vocabulary-leaf-crate.md) — `TextCellAddr` and `ElementId` live in `paged-wire`
