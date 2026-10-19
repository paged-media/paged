# ADR 248 — An answer says what is true: failures fail, late answers are dropped, readers follow

- **Status:** Accepted 2026-10-19.
- **Scope:** `packages/shell/src/state/document-loader.ts`, `content-selection-context.tsx`,
  `demo/automation.ts`, `catalog/use-collection.ts`; `packages/client` (`changesTheDocument`,
  `documentStats`, `colorProfileNames`, `registerFont`); plugin-sdk's object registry `query`
  and `supports("storage.blob@1")`; `apps/canvas/src/plugin-blob-store.ts`; the sheet bundle's
  typed `importXlsx`; the `paged.frame` proxy in paged-script.

## Context

Three shapes of the same fault, each answering something that was not so.

- Failures answered as successes (R18): `editor.setProperty` dropped the engine's refusal
  (AUTO-1), `editor.query` answered `[]` for a selector that does not parse (AUTO-2), the typed
  `importXlsx` resolved for bytes that are not a workbook (SHT-1), an assignment through
  `paged.frame(…)` ran on after `paged.set` refused it (SCR-12), and
  `supports("storage.blob@1")` said true where every write rejected (HOST-2).
- Answers applied after they were superseded (R20): a second open did not stop the first
  open's snapshot pass (SH-105); a caret answer landed after Escape (SH-106).
- Values read once and never again (R15): the stats tiles kept the load's counts (PN-300,
  PN-304), a registered font's family stayed "missing" (PN-106), a profile registered before
  the panel opened was not offered (PN-158), a renamed master kept its old name (PN-208),
  the Export Center did not list the plugins' exporters (PN-309); and the client registered the
  default faces again after every load, a copy of the font each time (PAR-2).

## Decision

- A refusal is answered as a refusal in every door: the automation rejects with the engine's
  reason, the object registry's `query` rejects `invalidSelector`, `importXlsx` rejects (and the
  open workbook stays, since the engine replaces it only on success), the frame proxy throws.
  A capability flag says what is true: a blob store may say it cannot persist now
  (`BlobStore.available`), and the editor's says so when OPFS refuses its root.
- An answer is applied only while the request it answers is the newest: one load number for
  every open and New (`newestLoad`), one selection number for the caret and rects answers.
- A view that read the document reads it again after every change, by one predicate
  (`changesTheDocument`: mutation, undo, redo, a gesture's commit, a script, a font registered
  or cleared, a part written). The counts have no request of their own, so the client asks for
  them through the door that answers them (`documentStats`, the last selection posted again).
  A list of things registered with the worker is kept where they are registered (the client's
  `colorProfileNames`) so a late view can seed from it. A face the client already registered
  byte for byte is not posted again.

## Consequences

AUTO-1, AUTO-2, SHT-1, SCR-12, HOST-2, SH-105, SH-106, PN-106, PN-158, PN-208, PN-300, PN-304,
PN-309 and PAR-2 close. SCR-14 (a placed link to a missing file reads "ok") and PAR-1 (the
engine keeps each load's fallback font) are engine findings of the same shape and stay open.
An engine request for the counts (`requestStats`) would replace `documentStats`' re-post.
