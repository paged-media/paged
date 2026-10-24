# ADR 293 — A template opened as a document says so, and offers "Edit template"

- **Status:** Accepted 2026-10-24.
- **Scope:** `apps/canvas/src/panels/template/template-notice.tsx`, its mount in
  `apps/canvas/src/app/mount.tsx` (`<PagedShell notices>`), the shell's `notices` slot
  (`packages/shell/src/PagedShell.tsx`). Decided by the composable-editor concept,
  [§12, "Decided on 2026-10-24"](../composable-editor.md), item 4.

## Context

Roles are per session (concept §7.6): the host decides them, and a document does not carry the
role it is to be edited in. The full editor starts as an `editor`. A template opened there is
edited as a document: its fields and its permissions stay as the author set them, the field
outlines are not drawn (they are the author's and the filler's), and nothing on screen says the
document is a template. The ways to author it existed but were all somewhere else: the Template
panel's "Author template" button (ADR 276, plan F1), "Preview as filler" in the same panel, and
File ▸ Open as template… (engine ADR 1002) for a tagged document that has no fields yet. A user
who opened a template from a file had to know to look for the panel.

The decision of 2026-10-24 keeps roles per session (no document-bound roles) and asks the full
editor to show a template as a template and to offer "Edit template" explicitly.

## Decision

1. **A notice under the header.** When the open document has template fields (the engine's
   `templateFields` collection is not empty) and the session's role is `editor`, a strip under
   the header and the edit-context breadcrumb says so: "This document is a template with N
   fields. You are editing it as a document; its fields and what a filler may do stay as they
   are." German ships with it.
2. **"Edit template" is the explicit switch.** It sets the session's role to `author` (the same
   door as the Template panel's button: `useSetSessionRole`, which a host that keeps the role
   observes through its instance) and opens the Template panel. "Hide" hides the notice until
   the next document is loaded.
3. **It is offered only where it can act.** No notice when the role cannot be switched from the
   UI (no role setter), when the profile does not offer the Template panel (not registered, or
   `panel:paged.template` switched off), or when the role is not `editor`: a filler's and a
   viewer's sessions are the template-fill and viewer presets, and an author is already
   authoring. So the notice belongs to the full editor and the profiles built like it.
4. **A slot, not a region.** The shell takes `notices` (`<PagedShell notices>`), rendered
   between the breadcrumb and the work area; each notice renders nothing when it has nothing to
   say. It is not a profile region: it carries no ids a host places, and a host turns the
   template notice off by switching off the Template panel or by not allowing the role switch.

## Consequences

- Opening a template in the full editor no longer looks like opening any document; the step
  to author it is one click and named as such.
- Roles stay the host's decision: the notice uses the role switch the session already has, and
  a host that does not allow authoring does not get the notice.
- Tests: `apps/canvas/test/panels/template-notice.dom.test.tsx` (the notice over the real engine,
  "Edit template" switching to the author, "Hide", no notice without the Template panel).
