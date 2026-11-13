# ADR 1211 — One way out of a context: an exit resolver, and a stack that runs each hook once

- **Status:** Accepted 2026-11-13.
- **Scope:** `packages/shell/src/state/context-exit.ts` (`resolveContextExit`, the resolve
  prompt's queue), `state/edit-context-store.ts` (the reducer and its effect queue),
  `state/edit-context-stack.tsx` (the provider, `leave`, `leaveAll`, `leaveTo`, `checkScope`,
  `useContextExit`), `state/edit-context-controller.tsx`, `state/replace-guard.ts`
  (`setContextResolver`), `state/selection-context.tsx` (`activeGroupPath`),
  `chrome/ContextExitPrompt.tsx`, `chrome/EditContextBreadcrumb.tsx`, `chrome/ToolRail.tsx`;
  the modules' contexts declare `exitPolicy` (extensions ADR 1106). Tasks CM1 and CM2 of
  [`interaction-plan.md`](../interaction-plan.md); D-04 of [ADR 1201](1201-interaction-decisions.md).
  Amends [ADR 250](250-escape-climbs-out-of-a-group.md) and
  [ADR 281](281-the-canvas-mounts-frame-surfaces.md).

## Context

An edit context ended in five ways with five meanings: Escape cancelled it, a press outside the
frame committed it, the breadcrumb only popped it (neither its commit nor its cancel ran),
another tool and another selection committed it, and a document switch left it on the stack
of a document that was gone. No module could say that its unfinished work must not be lost
without a question. The stack ran the contexts' hooks inside React `setStack` updaters, which
run when React decides — twice under StrictMode, later than the call when the fiber has pending
work — so a hook could run twice or never; and it kept the hooks by context type, so two
stacked contexts of one type shared one entry. `isInScope` recognised the entered root only.
The breadcrumb showed contexts but not the groups a double-click had entered.

## Decision

1. **The stack is a reducer and a post-commit effect queue.** `reduceEditContexts` is pure:
   state and action in, next state and the hooks to run out. `dispatch` commits the next state
   (the snapshot every reader sees), then runs the hooks in order, each exactly once; a hook
   that acts on the stack (a context leaving itself from `onEnter`) queues behind them. Each
   frame has an id of its own and its hooks are kept under it. Entering the same context on the
   same root when it is on top changes nothing and runs nothing (UXI-CTX-002); `null` and `[]`
   tool lists stay two facts (UXI-CTX-004); a throwing hook never wedges the stack
   (UXI-PLG-005). The provider reads the store with `useSyncExternalStore` and now compiles.
2. **One exit resolver.** `resolveContextExit(reason, { dirty, exitPolicy })` answers `commit`,
   `cancel`, `pop` or `ask` for every way out — `escape`, `click-outside`, `breadcrumb`,
   `tool-pick`, `selection-change`, `document-switch`, `profile-change`:

   | Reason | Clean | Dirty, commit-if-safe | Dirty, ask | Dirty, discard-allowed |
   |---|---|---|---|---|
   | escape | commit if the policy is commit-if-safe, else cancel | ask | ask | cancel |
   | click-outside, breadcrumb, tool-pick, selection-change, profile-change | commit | commit | ask | commit |
   | document-switch | pop | ask | ask | cancel |

   A clean context never asks. Nothing is discarded without an explicit cancel or the module's
   own declaration that discarding is allowed. A context that declares no policy is
   `discard-allowed`, which is what the host did before (Escape cancels, a press outside
   commits). A dirty context on Escape is normally resolved one tier earlier by its sub-edit
   (ADR 1207's `context-dirty` tier: a cell being typed, a transform box); the context stays
   until that is done.
3. **Ask is a small question**, `ContextExitPrompt`: Keep changes (commit), Discard changes
   (cancel), Cancel (stay). Escape, the backdrop and Cancel keep the context; the default
   button keeps the work. With no prompt mounted the answer is Keep. Two exits while one
   question is open ask once.
4. **Every path uses it.** Escape (`leave("escape")`), picking another tool on the rail or by
   any other way (`leave("tool-pick")`; Cancel in the prompt puts the context's tool back),
   selecting outside the context's scope (`leaveAll("selection-change")`; Cancel selects the
   root again), the breadcrumb (`leaveTo`), and the canvas's press outside the frame
   (`leave("click-outside")`, below). A module's own exit (`host.shell.exitEditContext`, a
   frame surface's `exit`) still commits or cancels as it asks, and Enter still commits a
   context that declares `onCommit`.
5. **The canvas's press outside the frame.** `ViewportCanvas.tsx` (track IC) replaces its
   `commit()` with `if (editContextStack.leave("click-outside").outcome === "asking") return;`
   — "left" lets the click act on what it landed on (D-04's clean case); "asking" means the
   prompt holds the press. `useContextExit()` offers the same call and `resolution(reason)`,
   which answers without acting.
6. **A document switch resolves contexts before the replace question.** The stack registers
   with the replace guard (`setContextResolver`): `confirmReplace` asks about each dirty context
   first, whether or not the document is dirty (typed source not yet committed is no document
   edit). Cancel keeps the document and the context (UXI-T43). A clean context stays until the
   document is really replaced; the controller then clears the stack with nothing to keep or
   revert.
7. **The write scope** is the entered root and what the engine's scope query says lies inside
   it: `checkScope(ids)` asks `client.scopeContains` (EN5, protocol 80) when the client has it,
   and `isInScope` reads the last answer. Without the query only the root is in scope, never
   presented as a subtree (UXI-CTX-011). Selecting inside the scope keeps the context;
   selecting outside leaves it (UXI-CTX-010).
8. **The breadcrumb shows entered groups** as levels before the contexts (`activeGroupPath`,
   kept from the hit's group chain when a double-click enters a group). An ancestor crumb goes
   back to that level and keeps it; the last crumb leaves its level; the Esc button leaves one.

## Consequences

- `UXI-T40` to `UXI-T44` hold at the component layer
  (`packages/shell/test/state/edit-context-store.test.ts`,
  `apps/canvas/test/shell/edit-context-exit.dom.test.tsx`), the module journeys in
  `tests/e2e/uxi-module-conformance.spec.ts`.
- The breadcrumb's plain pop is gone: leaving by it now commits, as a press outside does.
- paged.slide's chart: Escape on the page now keeps the chart's edits, as Escape in its data
  sheet already did (its context is `commit-if-safe`).
- Until EN5 reaches the client, selecting a member of an entered frame leaves the context, as
  before; the scope query switches it on without a change here.
- `profile-change` has no caller yet: profiles are chosen when the editor mounts. A runtime
  switch calls `leaveAll("profile-change")` first (UXI-PLG-008).
