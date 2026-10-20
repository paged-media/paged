# ADR 200 — Threading drops the target's empty story; "\r" is a paragraph return; an unset margin reads as laid out

- **Status:** Accepted 2026-10-20.
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
