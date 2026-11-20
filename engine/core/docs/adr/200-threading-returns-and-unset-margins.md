# ADR 200 — Threading drops the target's empty story; "\r" is a paragraph return; an unset margin reads as laid out

- **Status:** Accepted 2026-10-20; amended 2026-11-18 (`deleteFrame { withStory }` takes the story the frame alone held) and 2026-11-20 (a frame unthreaded from its own story can be threaded back).
- **Scope:** `paged-mutate` (`apply_link_frames`), `paged-canvas` (`apply_insert_text`, the page
  arm of `virtual_set.rs`), `paged-introspect` (`schema.rs` text coercion), `paged-cli`
  (`main.rs`, `render.rs`, `package.rs`, `engine_serve.rs`).

## Context

Four findings of the conformance index, each a place where the engine kept or reported
something other than what it lays out or what InDesign does:

- SCR-6: after `linkFrames(a, b)` the second frame's own empty story stayed in the document,
  held by no frame.
- SCR-13: `insertText` split paragraphs on `"\n"` only, so `"\r"`, the paragraph return of
  InDesign scripting, landed in the story as a literal character.
- PN-203: a page with no margins of its own read `null` for its margins (a panel then showed
  the schema default, 36 pt), while the pages collection and the layout use 0 pt in one column.
- The colour group's members row (a list carried as space-separated text) refused `""`, so
  removing a group's last swatch was refused and the group kept it.

## Decision

- Linking into an empty frame removes that frame's own story when, once threaded, no frame or
  text path on a spread or master names it, as InDesign discards it. The link's inverse puts
  the story back whole before the frame returns to it, so undo is exact.
- An inserted text's `"\r"`, `"\r\n"` and U+2029 each start a paragraph, as `"\n"` does. The
  text is normalised before anything measures it, so the inverse covers exactly what went in.
- A page with no margin entry reads the values it is laid out with (0 pt margins, 0 pt gutter,
  one column), the same the pages collection reports. The first write still creates the entry.
- An empty string is a value for a list carried as text: the empty list.
- `paged` on the command line: a reader that closes the pipe early ends the process quietly
  with the shell's broken-pipe status (141) instead of a panic; `render --all` always writes
  `<dir>/page-NNN.png`; a failed `package` leaves no half-made folder; `engine-serve` answers a
  body that is not JSON with 400 and a JSON error. SIGPIPE itself is not reset, so a client
  hanging up does not end `engine-serve`.

## Consequences

- SCR-6, SCR-13, PN-203, CLI-1, CLI-3, CLI-8 and CLI-9 close; their tests assert the behaviour
  above.
- A frame threaded into a chain no longer has a story of its own to return to after a user
  `unlinkFrames` (the chain's story keeps flowing to where the chain now ends), as in InDesign.

## Amendment 2026-11-18 — `deleteFrame { withStory: true }` takes the story the frame alone held

`deleteFrame` keeps the story of a text frame it deletes: a story no frame or text path places any
more. That is deliberate: such a story is free to be put on a path (draw's Type on a Path flows an
existing story, and a story still in a frame is refused), and undoing the delete re-attaches it.
The IDML export leaves a story nothing places out, as InDesign discards it, and says so in a loss
line. But a caller that deletes frames it made, or a template it consumes, has no use for their
stories: a Data Merge with Keep template off left the template's stories in the merged document
("4 items left out" on export), and a re-merge one more per frame it cleared (data ADR 566,
amendment of 2026-11-18). No wire op could remove a story.

- `deleteFrame` takes an optional `withStory` (default false: unchanged). With it, the story the
  delete leaves held by nothing goes in the same step: the text frame's own story, or a text path's
  on a shape or line, with the stories anchored in it and the hyperlinks whose source text they
  hold. "Held by nothing" is the export's own test (`idml_export::placed_story_ids`: a frame or text
  path on a spread or master, or an anchored frame in a placed story), placed before the op and not
  after it, so a story still threaded on to a frame that stays is kept, and one that two deleted
  frames shared goes once, after both.
- The stories are read before the op applies (a frame named by a handle minted in the same batch
  has none yet) and removed after it (`paged-canvas`'s `unheld_stories.rs`, from
  `CanvasModel::apply_operation_with`). The removal is folded into the op's undo step: undo puts
  the stories and hyperlinks back before the frames return to them, so the document is restored
  exactly, and redo removes them again.
- An additive wire field: an older engine ignores it and keeps the story, as before. No protocol
  bump.
- The editor's Delete and `deletePage` are unchanged; whether they should take stories too is left
  to the Type on a Path workflow, which needs a free story.
- `delete_unheld_stories.rs` and `data_merge_pages.rs` assert the rule.

## Amendment 2026-11-20 — threading back into a frame unthreaded from its own story

A user unlink (`unlinkFrames { frame }`) clears the frame's `NextTextFrame` and leaves the
frames after the break on the story: the composer's chain walk no longer reaches them, so
they show nothing and the first frame is overset. Threading back into one of them is the way
back, but `linkFrames` refused it: the target "owns story content", because its story is the
threaded story and that has text. A broken thread could be mended only by undo.

`linkFrames(from, to)` now also accepts a `to` that is a frame of `from`'s own story which the
story's chain does not reach: no frame of the story threads into it, and it is not the chain's
head as `frame_chain` finds it (the story's first frame, in document order, that nothing
threads into). The head holds the text and stays refused; a frame the chain still reaches is
refused as before; the cycle check is unchanged. Nothing about the target's story changes, so
there is no story to drop and undo restores the unlinked state. Found filming the designers
film on a sample publication, where the page's interview is unthreaded and threaded again
through the ports (`paged-mutate`, `unthreaded_from_own_story`; tests
`relink_after_unlink_threads_back`, `link_into_the_story_head_is_rejected`,
`link_into_a_threaded_frame_of_the_same_story_is_rejected`).
