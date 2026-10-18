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
(`packages/plugin-sdk/src/host-impl.ts:1349-1351`, `:2364-2369`).

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

- `packages/plugin-api/src/host.ts:1562-1684` — the 26 required members; the comments give
  each door's no-backend answer and its probe string
- `packages/plugin-sdk/src/host-impl.ts:110-188` — `HOST_FEATURES`; `:122-129` the split
- `packages/plugin-sdk/src/host-impl.ts:3053-3186`, `:3213` — the dynamic flags and
  `supports`; `:3074-3076` a "feature PROBE must never be the thing that throws"
- `packages/plugin-sdk/src/host-impl.ts:2364-2411` — the shell wrapper and its answers
- `packages/plugin-sdk/src/host-impl.ts:2617-2658`, `:2219-2228`, `:2759-2768` — blob, consent, open
- `packages/plugin-sdk/test/host-doors.spec.ts:67-91` — tests of three doors with no backend

## Alternatives considered

Reserved members that throw `PluginApiNotImplemented` were the earlier pattern. The class is
still exported (`packages/plugin-sdk/src/host-impl.ts:190-199`), but nothing in the repo
constructs it; `packages/plugin-sdk/test/edit-context.spec.ts:19-23` records that the last
two such doors now register. A rejection for `shell.saveFile` was not chosen because it would
become an unhandled promise in a click handler (`packages/plugin-sdk/src/host-impl.ts:2396-2400`).

## Consequences

One bundle build runs on hosts of different ages, and host applications adopt doors one at
a time (`packages/plugin-sdk/src/host-impl.ts:835-845`). A bundle has to probe before it
relies on an injected backend: a read door without one answers like an empty result.
`HOST_FEATURES` is kept by hand (`CLAUDE.md:51-52`).

`supports()` describes doors, not the engine. It does not say which mutations or property
paths the running engine accepts (`DESIGN.md:193-197`). Two plugins probe the engine by
trying, and both rest on the write door returning a non-applied outcome
([ADR 310](310-one-write-door.md)):

- plugin-draw sends one deliberately unknown mutation and reads the engine's operation list
  out of the error (`plugin-draw: packages/draw-bundle/src/commands/join-average.ts:236-297`).
  Its stated rule: "Which lane runs is decided by `engineOpVocabulary()` below (a probe, not a
  version guess)" (`plugin-draw: packages/draw-bundle/src/commands/join-average.ts:39-41`).
- plugin-doc sends a batch and, when it is refused, replays it operation by operation; the
  refused style paths decide whether the document is lowered again, because the plugin API
  "has no flag that says so up front" (`plugin-doc: packages/doc-bundle/src/pour.ts:58-96`,
  `plugin-doc: packages/doc-bundle/src/open.ts:139-165`).

Documents contradict the code. `CLAUDE.md:53-55` and `DESIGN.md:97-99` still state the
throwing rule. `packages/plugin-api/src/host.ts:965-966` says `storyContent` throws on a host
without a backend; the adapter forwards the query and returns `null`
(`packages/plugin-sdk/src/host-impl.ts:2004-2017`). `packages/plugin-sdk/src/harness.ts:49-50`
lists two doors as still throwing.

## Related

- [ADR 301](301-host-adapter-lives-in-plugin-sdk.md) — the injected backends
- [ADR 304](304-bundle-lifecycle.md), [ADR 310](310-one-write-door.md) — the load check; outcomes
- [ADR 010](010-raw-mutate-gate-capability-enforcement.md) — refusal of an undeclared use
