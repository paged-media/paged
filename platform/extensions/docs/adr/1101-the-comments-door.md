# ADR 1101 — The comments door: `host.comments` over the document door, and `contribute.commentAnchor`

- **Status:** Accepted 2026-11-01.
- **Scope:** `packages/plugin-api/src/comments.ts` (the types), `host.comments` and
  `ContributionSurface.commentAnchor` in `host.ts`; `packages/plugin-sdk/src/doors-comments.ts`
  (`createCommentsSurface`, `createCommentAnchorRegistry`, `threadsOf`), `host-impl.ts`
  (`options.commentAnchors`, the flags), `harness.ts`; `test/comments-door.spec.ts`.
  Engine [ADR 1055](../../../../engine/core/docs/adr/1055-one-comment-model-for-every-module.md) is the model.

## Context

Engine ADR 1055 made every module's comments one document-level thread model with four
non-text anchors (`item`, `page`, `region`, `cell`) and deferred a public door. Modules reach
the threads today by sending raw `insertCommentThread` / `replyComment` mutations and reading
the `comments` collection by hand (slide and sheet each carry a copy of the row handling). A
`cell` anchor is an address only its module understands; the host pins it at its item's
top-left because nothing tells it more.

## Decision

**`host.comments`, probe `supports("comments@1")`.** Seven members:
`list(filter?)`, `get(threadId)`, `onDidChange(listener)`, `startThread(anchor, text, author?)`,
`reply(id, text, author?)`, `edit(commentId, text)`, `resolve(id, resolved)`,
`remove(commentId)`. Reads return `CommentThread` (the root comment first, then replies;
`anchor`, `resolved`, `orphaned`, and the `page` and `at` the engine resolved). A text-range
thread is listed with a `text` anchor and cannot be started here.

**No new engine operation.** The surface is built over `host.document`: `list` reads the
`comments` collection and groups its rows; each write is one `document.mutate` (a `batch` when a
person is entered first) of `setPerson`, `insertCommentThread`, `replyComment`, `editComment`,
`resolveComment` or `deleteComment`. So the document door's gate, undo steps and change events
apply unchanged: reads need `capabilities.document.read`, writes `capabilities.document.write`.
No new capability, no manifest change.

**Typed negative answers.** A write returns `{ ok: true, ... } | { ok: false, reason }`: an
unwritable document, an engine refusal, an unknown id, an empty text. It does not throw for a
refusal. `get` of an unknown thread is `null`. The static flag `comments@1` (ADR 305) says the
door exists wherever the document door does.

**Ids.** `reply` and `resolve` take a thread id or any comment id of the thread; a reply goes to
the thread's root, `resolve` of a thread id resolves its root. A comment's id is made by the
door (so `startThread` returns it) and the engine's thread id is read back.

**`onDidChange`** fires after a committed document change that altered the comments: the door
re-reads the collection and compares it with its last read, so strokes and style edits are
silent, and a write here, the host's Comments panel, an undo and a load all count.

**`contribute.commentAnchor({ id, kind: "cell", resolve(address, item) })`.** A module that
owns an address space answers `{ rect?, label? }` in the item's own space (points from its
top-left), or null when the address is not its own; the first non-null answer wins. The shared
`CommentAnchorBackend` (`createCommentAnchorRegistry`) is injected as `options.commentAnchors`;
`supports("contribute.commentAnchor@1")` is true only then. Without it the call is a no-op
handle. The id must be namespaced under the manifest id. ADR 1055 calls this contribution
`commentAnchorResolver`; the public name is `commentAnchor`.

## What the host still needs

The editor does not inject the registry yet, so the flag is false there. A host that reads it
adds `commentAnchors: createCommentAnchorRegistry()` to the options it gives every bundle host
and passes `resolve(item, address)` to its pins and Comments panel: the pin sits at the
thread's `at` plus the rect's top-left (an item's rotation is not applied), the row shows the
label. Until then pins stay at the item's top-left, as today.

## Consequences

- Slide's and sheet's comment models can drop their raw mutations and row parsing in favour of
  `list`, `startThread`, `reply`, `edit`, `resolve` and `remove`. Format-specific `source` blobs
  and bulk import (`commentMutations`) still go through `document.mutate`: the door is for
  interactive use, not for import.
- A bundle's tests run through the harness, which shares one anchor registry
  (`harness.commentAnchors`).
- plugin-sdk and plugin-api 0.74.3-canary.70.
