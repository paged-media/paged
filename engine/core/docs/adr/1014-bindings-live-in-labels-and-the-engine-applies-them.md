# ADR 1014 — Bindings live in labels, and the engine reads and applies them

- **Status:** Accepted 2026-10-24.
- **Scope:** `paged-data-*` (moved from `modules/data`, PM-0015 step 3); `paged-data-session`
  (`DataSession`, moved from `data-js`; `labels.rs`; `refresh_queries`); `paged-data-store`
  (`guard.rs`); `paged-wire` (`selector.rs`: escapes in quoted values); `paged-cli`
  (`data.rs`, `paged data bindings`, `paged data apply`). Decided by
  [PM-0015](../../../../docs/adr/PM-0015-data-and-actions-are-platform-layers.md) (record
  "core 1014"); follows [ADR 1000](1000-a-template-policy-lives-in-labels.md), which put the
  template policy in labels for the same reason.

## Context

paged.data binds page items, text variables and object properties to data. Since data ADR 559 it
writes each binding whose target is one page item into that item's label
(`x-paged:media.paged.data`: the binding with its target relative to the item, the queries it
reads, the source descriptors), and the whole recipe into the document label. Labels are what
InDesign keeps through an open and a save; the container part paged.data also writes is dropped
there, and every `Self` is renumbered.

Only the data module read those labels. A document's bindings were inert anywhere the module was
not loaded: on the command line, on the server, in another host. PM-0015 makes data a platform
layer, with bindings part of the document model (L1) and the binding engine an engine crate (L2).

## Decision

**The label is the model's form of a binding.** No second representation is added to
`paged-model`: a binding stays where the document already carries it, in labels that IDML, the
`.paged` model part and undo all keep. What changes is who can read them. The binding engine is in
the engine (`engine/core/crates/paged-data-*`, moved with their history), and the session that joins
it (`paged-data-session`'s `DataSession`) with it; `modules/data/data-js` is the wasm shim over
that session.

**One reader.** `data_session::labels::restore_from_labels` rebuilds the recipe from a document's
labels. It is the Rust form of the bundle's `restoreFromLabels`:

- the document label's recipe first, then every element label;
- an element's copy of a binding wins, because its target is the element as it is today;
- InDesign's `<?AID xxxx?>` escapes are decoded.

Both readers replay `modules/data/conformance/labels/cases.json`, whose answers are recorded from
the bundle's reader, so a document reads to the same recipe in the editor and on the command line.

**One guard.** A query in a document is code the document carries (data spec §11). Before the
store runs it, it passes `data_store::guard::check_query`, the Rust form of the bundle's lexer
guard:

- one SELECT over the source tables;
- no statement word;
- no table function that reads a file or a URL.

Both guards replay `modules/data/conformance/query-guard/cases.json` (41 refusals, 9 admitted
queries with their rows). `DataSession::refresh_queries` runs the session's queries as the
bundle's refresh does: each one is guarded, and a refused or failed query is reported while the
others still run.

**The engine applies them.** `paged data bindings DOC` lists the bindings the labels carry, the
object each one writes, and the files the recipe's sources ask for. `paged data apply DOC
--source ID=FILE … --record N -o OUT` works in four steps:

1. Import each file into the store under its source id.
2. Run the queries through the guard.
3. Resolve the bindings at record `N`.
4. Write the values with `Mutation::Set`, the door the editor and `paged set` use. Property
   bindings are written on the objects their selectors name; variable bindings on their text
   variables (`paged:<key>`, `textVariableContents`).

What the headless lane cannot write yet is listed per binding as `notHeadless`, never skipped. That
covers images, tables, barcodes, record flows, rules, and a colour no swatch has (these need the
module's lowering writers or a swatch mint).

**One selector grammar.** The durable selector of a labelled page item is
`frame[label.x-paged:media.paged.data*="\"oid\":\"pd-…\""]`, a quoted value holding its own quotes.
The SDK's parser reads a backslash in a quoted value as an escape. The engine's did not: it refused
the selector, and the SDK fell back to its own evaluation. The engine's parser now reads `\x` as `x`
too. A selector with a backslash in a quoted value therefore means the same in both. Before, such a
selector meant a literal backslash in the engine, or was refused there.

## Consequences

- A bound document can be filled from CI, the server or a script with no module loaded, and
  `paged` answers what a document binds and which files it needs.
- The command line refuses the same queries the editor refuses, for the same reasons.
- The engine workspace builds Turso and the data crates; the `paged` binary links them. The
  published wasm packages (`canvas-wasm`, the viewer) do not depend on them.
- serde_json's `float_roundtrip`, which the data crates use, unifies across a `--workspace` build of
  the engine. The engine's suite passes with it.
- Still to come: the remaining binding kinds headless (they need the lowering writers to move down
  too), a `data@1` door over the same session (extensions ADR 343), and the bundle calling the
  engine's reader and guard instead of keeping its own (one implementation instead of two, held
  together by the shared cases until then).
