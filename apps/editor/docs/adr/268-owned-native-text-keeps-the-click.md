# ADR 268 — Owned native text keeps the Type-tool click

- **Status:** Accepted 2026-10-20.
- **Scope:** `packages/shell/src/state/use-edit-context-entry.tsx`.

## Context

A Type-tool click on content a plugin owns enters that plugin's edit context instead of
starting raw text editing (C-4), so a manual edit cannot corrupt what a plugin compiles: a
lowered spreadsheet table, a web frame. paged.doc also claims its frames, but what it places is
native text: a Word document lowered to host stories, and its edit context names the host's own
Type tool. The interception entered the Word context and swallowed the click, so no caret ever
reached a placed Word document, and its copy could not be typed into or formatted, by click or
by double-click.

## Decision

The owned-content entry still enters the owning context, and when that context names the host
Type tool (`paged.tool.type`) it reports the click as not consumed: the canvas goes on to place
the caret (or select the word or line) in the story under the pointer. Contexts that do not
name the Type tool keep swallowing the click, as before.

## Consequences

- Placed Word copy is edited and formatted like any other story, inside the Word context
  (`tests/e2e/doc-caret.spec.ts`).
