# ADR 1236 — The publication contract

- **Status:** Accepted 2026-11-14.
- **Scope:** `apps/canvas/src/contract/` (new: `model.ts` the record and its label, `assess.ts`
  the assessment, `source.ts` when it runs, the readiness and the issues, `actions.ts` writing
  it and the approval), `panels/contract-panel.tsx` (new: Publication contract),
  `issue-fixes.ts` (a requirement's fixes), `app/mount.tsx`, `panels/built-in-panels.tsx`,
  `panels/window-categories.ts`; `packages/shell/src/state/publication-readiness.ts` (new: the
  readiness per editor), `chrome/ReadinessBadge.tsx` (new: the header's badge), `chrome/Header.tsx`
  (beside the save status). The UX strategy's Concept I; task PX8 of
  [`interaction-plan.md`](../interaction-plan.md). Builds on
  [ADR 1221](1221-guided-export.md) and [ADR 238](238-the-default-pdf-is-one-the-document-can-meet.md)
  (the export's readiness check), [ADR 1223](1223-publication-health-on-the-page.md) (the issues)
  and [ADR 1234](1234-named-checkpoints.md) (the approved state kept).

## Context

What a publication must be when it goes out — PDF/X-4 on a coated profile, A4 with 3 mm bleed,
the house fonts only, pictures at 300 ppi, every product field filled, signed off by the art desk —
lived outside the document, in a brief or a printer's spec sheet, and was checked once, at export
(ADR 1221's readiness, the Preflight panel). The strategy asks for the publication to declare
those requirements itself and to be assessed against them continuously, without interrupting the
work, with approval as part of the record.

## Decision

1. **The contract is stored with the document**, as its own label `x-paged:contract` (PM-0018's
   carrier, as the design constraints of [ADR 1233](1233-constraints-are-validated-intent.md)):
   the PDF standard; the trim size every page has; the least bleed; an output intent, and the
   profile its name contains; no RGB pictures; every font available, and the families allowed;
   the least effective resolution; complete data (required template fields filled, no issue from
   paged.data); the approval (draft, in review, changes requested, approved; the reviewers; who
   changed it and when). Every change is one undo step; a `.paged` save and an IDML export keep
   it. Read field by field: a field that cannot be read is left out, never guessed.
2. **One checker, not two.** The assessment runs the export's own readiness check
   (`pdfReadiness`) on the contract's standard and the document's bleed — whether the standard
   can be met, fonts and links found, no story running over, in its words and with its fixes —
   and adds only what the contract promises beyond it. A missing font is a blocker when the
   contract needs every font; the contract's resolution floor replaces the export's 150 ppi. A
   requirement not met is a blocker; the export's warnings stay warnings; the approval is a note
   until approved.
3. **Assessed continuously.** The facts are re-read as the document changes (the pages, fonts,
   links, stories, template fields and the data's issues, as Publication health reads them), and
   the assessment is pure. Its readiness — Blocked, Needs attention, Ready, Approved — shows in
   the header beside the save status (a dot and a word, the dot alone where the save status
   shows its dot alone), its tooltip listing what is not met; a click opens the contract. A
   requirement not met that Publication health does not report itself (the page size, the bleed,
   the output intent, RGB pictures, families outside the contract, pictures between 150 ppi and
   the contract's floor, empty required fields) joins the publication's issues, on the pages or
   items it stands on, with the panel that meets it and the contract as its fixes. Nothing is
   changed to meet the contract.
4. **Approval is an explicit action.** Request review, Approve, Request changes and Back to draft
   are buttons, each one undo step recording who and when; Approve is not offered while the
   contract is blocked. An approval keeps the approved state as the checkpoint "Approved" on the
   document's timeline (ADR 1234), so Compare with current shows what changed since. A document
   change after the approval this editor saw reads "Approved, then edited" (needs attention).
5. **Made from the document.** Window ▸ Output ▸ Publication contract offers "Create from this
   document": its standard, the first page's size, its bleed, its output intent, every font
   available, 300 ppi, complete data, a draft approval — then each requirement is edited in place.

## Consequences

- The contract and the design constraints travel the same way; InDesign keeps the label and
  ignores it.
- "Approved, then edited" is known within a session; across sessions the "Approved" checkpoint
  and Compare with current say what changed.
- Tests: `apps/canvas/test/unit/contract/assess.test.ts` (the record and its shape check; ready
  and approved; every requirement against the document, the export's check reused; the issues
  that join Publication health, none repeated), `apps/canvas/test/panels/contract-panel.dom.test.tsx`
  (made from the document, ready; Approve one undo step), `apps/canvas/tests/e2e/px-contract.spec.ts`
  (the header's readiness; a page resized blocks it with an issue on that page, Undo makes it
  ready; Approve is one undo step and keeps the "Approved" checkpoint; an edit after it needs
  attention).
