# ADR 1219 — Operation feedback

- **Status:** Accepted 2026-11-13.
- **Scope:** `packages/shell/src/state/operation-feedback.ts` (new: the outcomes, the wording,
  the routing, one store per editor), `chrome/FeedbackToasts.tsx` (new: the one toast channel),
  `PagedShell.tsx` (the shell's warnings list goes; its flows report here; remedies run as
  commands), `state/document-loader.ts` (a failed open is listed in Problems),
  `apps/canvas/src/panels/problems-panel.tsx` (operations' unresolved failures, with their remedy
  and Dismiss), `apps/canvas/src/app/mount.tsx` (the clipboard's results),
  `apps/canvas/src/plugin-host-options.ts` (`notifySink`), and the contract's `host.notify`
  ([extensions ADR 1107](../../../../platform/extensions/docs/adr/1107-host-notify.md)).
  `UXI-FBK-001`, `UXI-FBK-002`, `UXI-FBK-003`, `UXI-ASY-009`, `UXI-ASY-010`, `UXI-ASY-011` of
  the interaction specification ([ADR 1200](1200-the-interaction-contract-is-adopted.md)); task
  DF8 of [`interaction-plan.md`](../interaction-plan.md). Completes UX audit F-02.

## Context

How an operation ended was said in as many ways as there were operations. The shell kept an
append-only list of warning sentences under the header, never cleared; the clipboard put "Paste:
the clipboard holds nothing to paste." into the Problems list, where it stayed; the export notice
had its own toast; an importer's failure (paged.publish's `.idml`) went to the console only, so a
damaged file opened nothing and said nothing (F-02). Engine messages reached the user verbatim. A
drag that failed on every move could not be told from one that failed once. Plugins had
`host.diagnostics` (a document's lasting state) and the console, but no way to say "this
operation failed, nothing changed".

## Decision

1. **One service per editor says how an operation ended.** `OperationReport { action, outcome,
   reason?, document?, remedy?, actions?, title?, detail?, correlationId?, source?, key?,
   channel?, prominent?, persistent? }`. The outcome is the specification's taxonomy (§18.4):
   `success`, `canceled`, `blocked`, `unsupported`, `invalid-input`, `conflict`,
   `recoverable-failure`, `fatal-failure` — a UI classification, not the wire's.
2. **An error says what, why, whether anything changed and what next** (`UXI-FBK-002`):
   `wordFeedback` builds "Could not move 2 objects: their layer is locked. Nothing changed. Unlock
   layer." from the action (a short verb phrase in the editor's language; German words it as a
   noun phrase, "Verschieben von 2 Objekten nicht möglich: …"), the reason, `document`
   (`unchanged`, `changed`, `unknown`) and the remedy's label. A `title` replaces the headline
   for a success that names its result.
3. **One place per kind** (`UXI-FBK-001`, `UXI-ASY-010`): inline beside a local control (the
   caller shows the worded sentence; `channel: "inline"`), the one toast channel for a brief
   result, Problems for an issue that stays (`persistent`, every fatal failure, `channel:
   "problem"`). A quiet success shows nothing; a prominent one (Save, Export, Import;
   `UXI-FBK-003`) is a toast. At most three toasts; a report with the key of a live toast
   updates it and counts (`4×`) instead of stacking another, so a repeated drag failure is one
   toast. A failure stays 8 s, a success 4 s, one with further actions 12 s, a fatal one until
   closed. A success with the key of a Problems entry resolves it.
4. **Technical detail stays behind Details** (`UXI-ASY-011`): the engine's words, a correlation
   id. The toast's words carry no stack and no internal id.
5. **The shell's flows report here.** The warnings list under the header is gone: a flow's
   warning sentence is a toast (one per sentence, counted), a worker's error is one toast per
   kind with the engine's words behind Details, a failed open is also a Problems entry ("Could
   not open broken.idml: … Nothing changed.") until that file opens or the entry is dismissed
   (F-02), the clipboard's refusals are toasts (they were Problems rows). A remedy is a command of
   the editor.
6. **Extensions say it through `host.notify`** (extensions ADR 1107): the editor routes each
   notification into this service with the bundle's id as its source and its key namespaced
   under it. paged.publish's IDML importer reports a failed open this way and resolves it when the
   file opens.

## Consequences

- F-02 closes: a file that does not open says so in a toast and in Problems, whichever path
  opened it (the shell's loader or a bundle's importer).
- Later tasks report through `reportOperation` instead of their own notices: the guided export
  ([ADR 1221](1221-guided-export.md)), the compatibility report's summary
  ([ADR 1222](1222-compatibility-report.md)), the issue fixes
  ([ADR 1223](1223-publication-health-on-the-page.md)).
- Tests: `packages/shell/test/state/operation-feedback.test.ts` (taxonomy, wording, routing, no
  storm, problems resolved), `test/chrome/feedback-toasts.dom.test.tsx`,
  `apps/canvas/test/panels/problems-panel.dom.test.tsx` (F-02), and the second test of
  `UXI-T66` in `apps/canvas/tests/e2e/uxi-import-report.spec.ts` (a damaged file: a toast, a
  Problems entry, the model and the history unchanged).
