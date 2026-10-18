# ADR 305 — Every door is always present; a missing backend answers honestly and `supports()` reports it

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `d90f727`.
- **Scope:** `BundleHost` in `packages/plugin-api/src/host.ts`; `HOST_FEATURES` and the door
  implementations in `packages/plugin-sdk/src/host-impl.ts`

## Context

Hosts differ. The editor injects many backends, the headless test harness few, and a host
that adopted the adapter earlier lacks doors added since
([ADR 301](301-host-adapter-lives-in-plugin-sdk.md)). The adapter's comments rule out two
failures: a bundle built against a newer contract failing to load on an older host, and a
missing member reaching a bundle as `host.shell.saveFile is not a function`
(`packages/plugin-sdk/src/host-impl.ts:1345-1347`, `:2360-2365`).

`DESIGN.md:59-62` gives the principle, capability detection over version sniffing:
`host.supports()` answers "can I?" at run time, the manifest's `apiVersion` answers "may I
install?" at load ([ADR 304](304-bundle-lifecycle.md)).

## Decision

`BundleHost` has no optional members. A door whose backend the host application did not
inject still exists and gives a typed negative answer: `null`, `[]`, `false`, a denial, a
rejected promise or a logged no-op. It is never `undefined` and never a not-implemented
error. `host.supports("area.member@major")` tells a bundle which case it is in.

- `HOST_FEATURES` is a static list of 37 strings for doors the adapter implements itself.
- 23 further flags are added when the host is built: 22 when the matching backend or editor
  channel is present, and `gpu@1` from the manifest's own declaration.
- Where both exist, the static flag says that the door exists and the dynamic one that a
  backend is wired (`contribute.schemaPanel@1` and `schemaPanel.renderer@1`).
- Examples without a backend: `shell.pickFile` resolves `[]`, `shell.saveFile` resolves
  `false`, `blob.read` resolves `null` and `blob.write` rejects, `network.requestConsent`
  denies instead of prompting, `nativeDocument.open` rejects, `widgets` is a plain-textarea
  fallback.

The capability gate is a separate question: an undeclared use is still refused
([ADR 010](010-raw-mutate-gate-capability-enforcement.md)).

## Evidence

- `packages/plugin-api/src/host.ts:1558-1680` — the 26 required members; the comments give
  each door's no-backend answer and its probe string
- `packages/plugin-sdk/src/host-impl.ts:106-184` — `HOST_FEATURES`; `:118-125` the split
- `packages/plugin-sdk/src/host-impl.ts:3049-3182`, `:3209` — the dynamic flags and
  `supports`; `:3070-3072` a "feature PROBE must never be the thing that throws"
- `packages/plugin-sdk/src/host-impl.ts:2360-2407` — the shell wrapper and its answers
- `packages/plugin-sdk/src/host-impl.ts:2613-2654`, `:2215-2224`, `:2755-2764` — blob, consent, open
- `packages/plugin-sdk/test/host-doors.spec.ts:63-87` — tests of three doors with no backend

## Alternatives considered

Reserved members that throw `PluginApiNotImplemented` were the earlier pattern. The class is
still exported (`packages/plugin-sdk/src/host-impl.ts:186-195`), but nothing in the repo
constructs it; `packages/plugin-sdk/test/edit-context.spec.ts:15-19` records that the last
two such doors now register. A rejection for `shell.saveFile` was not chosen because it would
become an unhandled promise in a click handler (`packages/plugin-sdk/src/host-impl.ts:2392-2396`).

## Consequences

One bundle build runs on hosts of different ages, and host applications adopt doors one at
a time (`packages/plugin-sdk/src/host-impl.ts:831-841`). A bundle has to probe before it
relies on an injected backend: a read door without one answers like an empty result.
`HOST_FEATURES` is kept by hand (`CLAUDE.md:51-52`).

`supports()` describes doors, not the engine. It does not say which mutations or property
paths the running engine accepts (`DESIGN.md:193-197`). Two plugins probe the engine by
trying, and both rest on the write door returning a non-applied outcome
([ADR 310](310-one-write-door.md)):

- plugin-draw sends one deliberately unknown mutation and reads the engine's operation list
  out of the error (`plugin-draw: packages/draw-bundle/src/commands/join-average.ts:236-297`).
  Its stated rule: "Version sniffing is not available to a bundle and would be wrong"
  (`plugin-draw: packages/draw-bundle/src/commands/v58-wire.ts:52`).
- plugin-doc sends a batch and, when it is refused, replays it operation by operation; the
  refused style paths decide whether the document is lowered again, because the plugin API
  "has no flag that says so up front" (`plugin-doc: packages/doc-bundle/src/pour.ts:58-96`,
  `plugin-doc: packages/doc-bundle/src/open.ts:139-165`).

Documents contradict the code. `CLAUDE.md:53-55` and `DESIGN.md:97-99` still state the
throwing rule. `packages/plugin-api/src/host.ts:961-962` says `storyContent` throws on a host
without a backend; the adapter forwards the query and returns `null`
(`packages/plugin-sdk/src/host-impl.ts:2000-2013`). `packages/plugin-sdk/src/harness.ts:45-46`
lists two doors as still throwing.

## Related

- [ADR 301](301-host-adapter-lives-in-plugin-sdk.md) — the injected backends
- [ADR 304](304-bundle-lifecycle.md), [ADR 310](310-one-write-door.md) — the load check; outcomes
- [ADR 010](010-raw-mutate-gate-capability-enforcement.md) — refusal of an undeclared use
