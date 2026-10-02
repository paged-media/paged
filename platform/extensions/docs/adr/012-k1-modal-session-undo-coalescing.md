# ADR 012 — K-1 modal sessions: the §8.0 seamless-undo coalescing boundary

**2026-06-12 · decision record · status: RATIFIED 2026-06-12 (the K-1 §8.0
undo-semantics fork; gates "K-1 contractually complete"). Implementation lands
after this record: the additive `onUndo?()/onCanUndo?()` hooks + the three-tier
coalescing below.**

**Sources:** the paged.sheet concept paper (plugin-sheets, `docs/concept.md`) **§8.0**
("sheets mode is a *view*, not a separate persistence world, so undo history
is seamless across modes … every confirmed cell/structure/style change is a
committed Operation §6.3") and §6.3 (the sheet engine's OWN op-log: each
Operation carries its inverse, O(affected) undo); an internal K-1 design note
(the contract: `isDirty`, `onCommit`, `onCancel`,
`onContentKey`); the internal gap register, **K-1** ("**§8.0 seamless-undo
boundary (`isDirty` plumbed, coalescing semantics TBD)**"); the implementation —
`plugin-sheets: packages/sheet-bundle/src/session.ts` (`typeCellChar` /
`backspaceCellEdit` / `commitCellEdit` → `engine.setCell` / `cancelCellEdit`;
`isCellEditing`), `plugin-sheets: packages/sheet-bundle/src/activate.ts:161-192` (the editContext: `onContentKey`
routes Enter→commit / Esc→cancel / printable→type; `isDirty: () =>
session.isCellEditing()`; `onExit: hideGridInFrame`),
`plugin-sheets: packages/sheet-host-model/src/lower-to-mutations.ts:13-16,248-251` ("ONE undoable
`batch`: frame + rules + binding metadata"); `packages/plugin-api/src/host.ts:333`
("undo/validation/collaboration semantics stay engine-owned") + `:395-396`
("the host applies the batch atomically (one undo step)") + `:141`
(`isDirty` "gates … the §8.0 seamless-undo boundary"); core wire `undo` /
`batch` (`packages/plugin-api/src/wire.d.ts`).

## The problem the spec hid

§8.0 asserts undo is "seamless across modes" because "every confirmed
change is a committed Operation." That is true *inside the sheet engine* —
but it conflates **two distinct undo stacks** that the implementation keeps
separate, and the coalescing boundary between them is unspecified (the internal
gap register, K-1: only `isDirty` plumbed).

The two domains, from the code:

1. **The core document undo stack.** Core grants **one undo step per applied
   `mutate`/`batch`** (`host.ts:395`; an atomic batch = one step). Undo/redo
   semantics are **engine-owned** (`host.ts:333`) — core has **no
   begin/end-coalescing primitive**: a step is exactly one delivered mutation.
   A sheet frame reaches the document as a *lowered* artifact via **one
   atomic batch** (frame + rules + binding metadata = one undo step;
   `lower-to-mutations.ts:13-16`).

2. **The sheet engine's op-log (§6.3).** Cell/structure/style edits run
   against the plugin's **in-memory Rust workbook** (`engine.setCell`), which
   is *outside* the core undo stack entirely. K-1's keystroke buffer
   (`typeCellChar` → on `commitCellEdit` → `engine.setCell`;
   `session.ts:611-663`) lives here. Core sees **nothing** during in-frame
   editing — no mutation is dispatched per keystroke or per cell.

So §8.0's "seamless" is currently aspirational at the seam: a user editing
cells in-frame produces undo history in the *workbook* that the *document's*
Cmd-Z cannot see, and the document's Cmd-Z would skip past the whole editing
session to the prior lowered batch. Today only `isDirty` is plumbed
(gating the discard prompt + Enter/Esc routing); the question this ADR
settles is **what a document-level undo does to an in-frame editing
session**.

## The decision

**Adopt a two-tier model with an explicit coalescing boundary: keystrokes
coalesce into per-cell commit steps on the workbook op-log; the *modal
session* is the document-level coalescing unit — the whole enter→edit→commit
session collapses to ONE core undo step (the re-lowered batch). While a modal
context is active, the document undo stack is suspended in favor of the
workbook op-log; on commit-exit the net change re-lowers as one atomic
batch.**

Concretely, three coalescing tiers, innermost to outermost:

- **Tier 0 — keystroke → cell (workbook).** `typeCellChar` / `backspace`
  buffer; `commitCellEdit` (Enter) writes **one** `engine.setCell` =
  **one workbook Operation** (§6.3, carries its inverse). Keystrokes within
  a single cell edit coalesce; they are **never** individual undo steps.
  `cancelCellEdit` (Esc) discards the buffer with **no** Operation. This tier
  already matches the code; the ADR ratifies it.

- **Tier 1 — in-session undo (workbook op-log).** While the modal context is
  active, Cmd-Z/Cmd-Shift-Z undo/redo **workbook Operations**, not document
  mutations. The shell routes undo/redo to `activeContribution` when a modal
  context owns the stack (a new `onUndo?()/onCanUndo?()` pair on
  `EditContextContribution`, additive — `Contract extends Real` holds, no
  wire/protocol change, no publish; same plumbing class as the existing K-1
  `onCommit`/`onCancel`). Absent the hooks, a context that doesn't own undo
  falls through to the document stack unchanged.

- **Tier 2 — session → document (one core batch).** On **commit-exit**
  (Enter-out / click-outside / mode exit), the session's *net* change
  re-lowers as **one atomic `batch`** — exactly the existing single-undo
  lowering property (`lower-to-mutations.ts`). One document undo step removes
  the entire session's effect. On **cancel-exit** (Esc with the session
  dirty), the workbook reverts to entry state and **no** document mutation is
  emitted (nothing to undo). This is the boundary §8.0 was missing: **the
  session, not the keystroke and not the cell, is the document's undo grain.**

The seam between Tier 1 and Tier 2 is the **modal entry/exit**: entering the
context *suspends* the document stack and hands undo to the workbook; exiting
*commits the net delta as one document step*. "Seamless across modes" (§8.0)
becomes true by construction — there is exactly one document-visible step per
editing session, and fine-grained undo lives where the edits live.

## Why this boundary (and not the alternatives)

- **Per-keystroke or per-cell document mutations (rejected).** Would require
  K-1 to dispatch a core `mutate` per cell edit — but the sheet model is a
  *workbook*, not document cells; there is no document-side representation of
  a cell until lowering. It would also flood the core undo stack with steps
  the user thinks of as one "I edited the table" action, and force a
  re-lower-per-keystroke. Rejected against §6.3 (the op-log is the workbook's
  undo authority) and the perf model.

- **No document step at all until save-back (rejected).** Would make the
  in-frame edits invisible to document Cmd-Z entirely — the user edits a
  table, presses Cmd-Z expecting the edit gone, and instead loses the
  *previous* document action. Violates §8.0's "seamless across modes" promise
  and the principle of least astonishment.

- **The chosen model needs no core change.** Core's "one step per batch"
  primitive (`host.ts:395`) already delivers Tier 2 — the session's re-lower
  is *already* one atomic batch. Tier 1 is pure SDK/editor wiring over the
  workbook's existing op-log (§6.3). So the decision is implementable with
  **no wire/protocol bump, no publish** — consistent with K-1's
  no-publish posture and the isolation contract (the gap is SDK/editor
  plumbing, never a core fork).

## Consequences

- **`EditContextContribution` gains additive optional members**
  `onUndo?()/onRedo?()/onCanUndo?()/onCanRedo?()` (the Tier-1 routing
  surface), alongside the existing `isDirty`/`onCommit`/`onCancel`. The compat
  assertion + a harness conformance test cover them (same verification split
  as the K-1 design note: contract types + host-impl recording are headless-testable;
  the live undo/redo loop is Playwright/manual).
- **The editor's edit-context-stack routes undo/redo** to the active
  contribution when it advertises `onCanUndo`, and restores document-stack
  routing on exit. The dirty gate (`isCellEditing`) additionally keeps an
  open cell buffer owning Enter/Esc (already wired).
- **§8.0 should be amended** to name the two stacks and the modal coalescing
  boundary explicitly, replacing the current "every change is a committed
  Operation → seamless" gloss, which is true only inside the engine.
- **The acceptance proof is the rotated-frame Playwright**:
  enter → select → type → commit → **one** document undo removes the
  whole session; and an in-session undo (Tier 1) reverses the last cell while
  the context is still active. Until that is green, "K-1 contractually
  complete" is not claimable.
- **Generalizes beyond sheets.** The same three-tier model is the contract any
  future modal editContext (paged.web's web edit context; paged.draw's
  in-frame vector edit) inherits: own a fine-grained inner stack, collapse the
  session to one document step on commit-exit. K-1 is where the platform
  decides it once.

## Amendment — 2026-10-02

Checked against this repo at `d90f727`, plugin-sheets at `71f37d7` and the editor at `28dc764`.
Tier 0 and Tier 1 exist as decided. Tier 2 does not: leaving the modal session produces no
document mutation. plugin-sheets is the one bundle that declares the undo hooks.

**1. The Tier-1 hooks landed, with the redo pair.**

- `packages/plugin-api/src/host.ts:217-234` — `onUndo`, `onRedo`, `onCanUndo` and `onCanRedo` on
  `EditContextContribution` (commit `f903925`, 2026-06-12).
- `editor: packages/shell/src/state/edit-context-controller.tsx:100-110` — while a context is
  active, Cmd-Z and Cmd-Shift-Z go to the contribution's `onUndo` / `onRedo` and do not reach
  the document stack. `editor: apps/canvas/src/main.tsx:1531-1546` does the same for the Undo
  and Redo menu commands. Both test for `onUndo`; neither reads `onCanUndo`.
- `plugin-sheets: packages/sheet-bundle/src/activate.ts:341-344` — the `sheet` context declares
  all four.
- `editor: apps/canvas/tests/e2e/sheet-modal-session.spec.ts:324-333` — in a rotated frame,
  Cmd-Z after a committed cell edit reverts the cell and the context stays active.

This supersedes "Implementation lands after this record" in the header for Tier 1, and "when it
advertises `onCanUndo`" in the second Consequences bullet (the editor keys on `onUndo`). In the
first Consequences bullet, "a harness conformance test cover them" does not hold for the undo
hooks: in this repo they appear only as type declarations (`packages/plugin-api/src/host.ts:228-234`)
and in one doc comment (`packages/plugin-api/src/binding-provider.ts:272`). The harness test
registers `onCommit` and `onCancel` and invokes `onCommit`
(`packages/plugin-sdk/test/harness.spec.ts:309-325`).

**2. Tier 1 runs on a journal in the bundle.** The log that Cmd-Z walks is held by the bundle's
session, not by the workbook engine: one entry per committed cell edit, carrying the previous and
the next input text, replayed through `engine.setCell`.

- `plugin-sheets: packages/sheet-bundle/src/session.ts:524-543` — the journal and its cursor.
- `plugin-sheets: packages/sheet-bundle/src/session.ts:548-567` — a commit reads the previous
  input, writes the cell and appends the entry.
- `plugin-sheets: packages/sheet-bundle/src/session.ts:1275-1306` — undo re-enters the previous
  input; a bulk operation (sort, replace-all, paste) is one grouped step.

This supersedes "undo/redo **workbook Operations**" and "the workbook's existing op-log (§6.3)"
as descriptions of the mechanism. Tier 0 is as written
(`plugin-sheets: packages/sheet-bundle/src/session.ts:960-1012`).

**3. Tier 2 is not implemented.**

- `plugin-sheets: packages/sheet-bundle/src/activate.ts:345-348` — `onExit` calls
  `clearCellEditJournal()` and `hideGridInFrame()` and nothing else. The context declares no
  `onCommit` and no `onCancel`; neither name occurs anywhere in plugin-sheets.
- `plugin-sheets: packages/sheet-bundle/src/session.ts:1342-1345`, `:1014-1017` — those two
  functions empty the journal, drop the open edit buffer and clear the scene layer. Neither
  calls `host.document.mutate`.
- `plugin-sheets: packages/sheet-bundle/src/activate.ts:145-148`,
  `plugin-sheets: packages/sheet-bundle/src/panels/workbook-panel.tsx:129` — lowering a range to
  the page runs only from the command `media.paged.sheet.command.lowerToFrame` and from the
  workbook panel, and it inserts a new frame
  (`plugin-sheets: packages/sheet-bundle/src/lower.ts:335-350`).

So leaving an in-frame session sends no mutation to the document: neither exit function calls
`host.document.mutate`, no code path in the bundle writes into the table of an existing frame,
and the session adds no step to the document undo stack. The exit handler does not restore
earlier cell values in the workbook. This supersedes the Tier 2 paragraph, "on commit-exit the
net change re-lowers as one atomic batch" in the decision, and the first half of the acceptance
proof ("**one** document undo removes the whole session"). The contract comment at
`packages/plugin-api/src/host.ts:220-222` still describes Tier 2 as behaviour; nothing in this
repo performs or checks it.

**4. Lowering is no longer one batch.** "Why this boundary" rests Tier 2 on the lowering being
"*already* one atomic batch". The default lowering now builds a native table through several
`host.document.mutate` calls:

- `plugin-sheets: packages/sheet-bundle/src/lower.ts:335-350` — a batch for the frame and its
  binding.
- `plugin-sheets: packages/sheet-bundle/src/lower.ts:377-379` — `insertTable`.
- `plugin-sheets: packages/sheet-bundle/src/lower.ts:198-205` — one `insertText` per non-empty
  cell.
- `plugin-sheets: packages/sheet-bundle/src/lower.ts:231-235` — one batch for swatches, spans,
  fills and edges.

`plugin-sheets: packages/sheet-bundle/src/lower.ts:182-191` records the cost: "The two-lane split
costs the single-undo atomicity the combined batch had, but it is the only shape the engine
applies." The single-batch lowering the Sources cite is the retained fallback
(`plugin-sheets: packages/sheet-host-model/src/lower-to-mutations.ts:19-39`), and its text is
poured by a separate call (`plugin-sheets: packages/sheet-bundle/src/lower.ts:465-469`). A
Tier-2 re-lower built on this lowering would therefore not be one document undo step.

**5. Line references.** In `packages/plugin-api/src/host.ts`: `:141` is now `:208-210`, `:333` is
`:759-760`, and `:395-396` is `:1002-1004` (a sentence in the comment on the object-type bake
contract). In plugin-sheets: `activate.ts:161-192` is now
`plugin-sheets: packages/sheet-bundle/src/activate.ts:288-349`, `session.ts:611-663` is
`plugin-sheets: packages/sheet-bundle/src/session.ts:960-1012`, and the single-batch comments
cited from `lower-to-mutations.ts` are at
`plugin-sheets: packages/sheet-host-model/src/lower-to-mutations.ts:36-39` and `:78`.
