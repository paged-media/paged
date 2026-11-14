# ADR 1235 — Every object answers the same verbs

- **Status:** Accepted 2026-11-14.
- **Scope:** `apps/canvas/src/verb-commands.ts` (new: the verbs, their host implementations, the
  resolution to a module's), `canvas-context-menu.tsx` (the verb rows, also inside a frame
  surface), `app/mount.tsx` (registration); `packages/shell/src/index.ts` (`readEnvelope`); the
  contract's `EditContextContribution.verbs`
  ([extensions ADR 1110](../../../../platform/extensions/docs/adr/1110-an-edit-context-names-its-verbs.md));
  the edit contexts of `modules/sheet`, `modules/image` and `modules/data`. Task PX9 of
  [`interaction-plan.md`](../interaction-plan.md), the strategy's Concept J ("a shared visual
  language for creative modules") and its §15 ("don't add a separate interface for every
  plugin"). Relates to [ADR 1218](1218-commands-say-why-they-do-not-apply.md) and the module
  conformance suite (task CM4, gate G2).

## Context

A sheet, a vector graphic, an image, a web frame, a Word document, a chart and a data binding
are each a module with its own panels and commands. What a user can do to the *object* — look
at its properties, transform it, copy it, bind it to data, style it, keep a version, check it,
export it — was found in a different place in each, or not at all, so every module taught its
own language.

## Decision

1. **Eight verbs, host commands.** `paged.verb.inspect`, `.transform`, `.copy`, `.bindData`,
   `.style`, `.version`, `.validate`, `.export`, titled "Inspect", "Transform…", "Copy", "Bind to
   data…", "Style…", "Save a version", "Validate", "Export…", category Object. They apply on a
   selection, a text selection or inside an edit context (ADR 1218 says why otherwise: "Select an
   object first").
2. **The module's where it has one, the host's otherwise.** The verb resolves the context —
   the active edit context, or the one the selected frame belongs to (the object type that claims
   it by its metadata, as a double-click resolves it) — and runs the command that context names
   for the verb (extensions ADR 1110). Without one the host's runs:
   Inspect opens Properties; Transform the Transform panel; Copy is Edit ▸ Copy (which follows
   the context already, ADR 231); Bind to data opens the Data panel; Style opens Paragraph Styles
   for text, Object Styles for an object; Save a version takes a named checkpoint in the History
   panel (ADR 285); Validate opens the publication's health (ADR 1223); Export collects the
   selection into Asset Export (ADR 288), or opens it.
3. **Shown the same everywhere.** The eight are the canvas context menu's first group, in this
   order and these words, on the page and inside a module's frame surface (after the bundle's own
   rows), and in the palette under the same titles.

## Consequences

- The built-ins name their own Copy and Export (sheet), Transform, Version and Export (image),
  Bind to data (data); the other contexts answer with the host's verbs until their modules name
  theirs.
- The module conformance suite (`tests/e2e/uxi-module-conformance.spec.ts`, G2) checks every
  module context: all eight are offered there, the context's declared verbs are commands the
  editor has, a verb runs the module's command where one is named and the host's otherwise, and
  Inspect changes neither the document nor its history; and that the context menu lists the
  eight first.
