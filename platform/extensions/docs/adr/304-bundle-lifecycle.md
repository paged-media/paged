# ADR 304 — Bundle lifecycle: one synchronous activate, structural teardown, guarded activation

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `d90f727`.
  Amended 2026-11-28: `API_VERSION` is `0.<generation>.<revision>` and moves with the contract
  (the amendment at the end).
- **Scope:** `packages/plugin-api/src/bundle.ts`; `load.ts`, `version.ts`, `disposables.ts` and
  `define-bundle.ts` in `packages/plugin-sdk/src`

## Context

A plugin has to be removable. `DESIGN.md:45-49` sets the bar: disposing a bundle must leave
the shell as it was found, and this is to be "enforced by construction", not by convention.

A host loads several bundles one after another. While the `activate` call in `loadBundle`
was unguarded, a throw in one bundle prevented every later bundle from loading, with nothing
naming the culprit (`packages/plugin-sdk/src/load.ts:93-99`).

## Decision

A bundle is `{ manifest, activate(host) }`, and there is no `deactivate` hook. `activate`
is synchronous: it returns a `Disposable`, not a promise.
The repository does not record why.
`loadBundle` is the host's one call per bundle and does, in order:

1. refuses any `options.trust` other than `"first-party"` ([ADR 319](319-trust-line.md));
2. refuses a manifest `id` that is not in reverse-DNS form;
3. refuses an `apiVersion` range that `API_VERSION` (`"0.2.0"`) does not satisfy. The range
   grammar is `*`, an exact version, or a caret; a caret on `0.x` locks the minor;
4. builds the host ([ADR 301](301-host-adapter-lives-in-plugin-sdk.md));
5. calls `activate` inside a `try`. A throw is not passed on: the host scope is disposed,
   the error's kind goes to the journal sink and a diagnostic to the diagnostics sink when
   the host injected them, and the caller gets an inert handle with `active: false` and
   `activationError`;
6. returns a handle whose `dispose()` calls the bundle's disposer and then, in a `finally`,
   the host's.

Steps 1 to 3 throw. Teardown is structural: the facades record their registrations in a
`DisposableStore`, which disposes them in reverse order and continues past a disposer that
throws. The bundle's own handle only has to release what it allocated outside the host.
`defineBundle` is an identity function for type inference.

## Evidence

- `packages/plugin-api/src/bundle.ts:28-40` — `BundleHandle` and `PagedBundle`; a "no-op
  disposer is legitimate"
- `packages/plugin-sdk/src/load.ts:66-87` — the three refusals; `:19-22` why they throw
- `packages/plugin-sdk/src/load.ts:93-126` — guarded activation; `:132-148` the handle and
  the `finally`; `:162-177` the inert handle
- `packages/plugin-sdk/src/disposables.ts:26-57` — reverse order, idempotent, a failing
  teardown "must not strand the rest"
- `packages/plugin-sdk/src/version.ts:25`, `:33-63` — `API_VERSION` and the range check
- `packages/plugin-sdk/test/host-impl.spec.ts:394-413` — a bundle disposer that throws: the
  error reaches the caller and the registered tool is gone
- `packages/plugin-sdk/test/journal.spec.ts:156-169` — three bundles, the middle one throws
  in `activate`: `active` is `[true, false, true]`

## Alternatives considered

- A bare `activate` call that lets the error escape: the state before commit `dd241f5`
  (2026-08-22). The comment that replaced it reads "Seven working plugins beat eight broken
  ones." (`packages/plugin-sdk/src/load.ts:99`).
- A working-looking handle for a bundle that failed: rejected as a teardown "that lies about
  having set anything up" (`packages/plugin-sdk/src/load.ts:164-165`).

## Consequences

A host learns of a failed activation from `active` and `activationError`, not from an
exception. The editor's own wrapper predates this: at its pinned commit
`editor: apps/canvas/src/plugin-load-guard.ts:108-117` still relies on `try`/`catch`, does not
read `active`, and its header (`:23-24`) still calls the SDK's call unguarded.

`loadBundle` awaits nothing: work a bundle cannot finish synchronously completes after the
bundle has been reported active. `loadBundle` also does not validate the manifest against
the schema ([ADR 303](303-manifest-schema.md)).

`API_VERSION` has been `"0.2.0"` in every revision of
`packages/plugin-sdk/src/version.ts`, while the packages moved to `0.2.37-canary.0`
([ADR 306](306-canary-releases.md)). The range check has therefore never told two releases
apart; added doors are detected with `host.supports()`
([ADR 305](305-doors-always-present.md)). All eight first-party manifests and the plugin
template declare `"^0.2"` (for example `plugin-draw: packages/draw-bundle/manifest.json:5`),
so a contract `0.3.0` would refuse every one of them at load.

`packages/plugin-sdk/src/version.ts:21-22` says full semver "arrives with publishing". The
packages are published and the grammar is still the minimal one.

## Related

- [ADR 300](300-type-only-contract.md), [ADR 301](301-host-adapter-lives-in-plugin-sdk.md) —
  the host object `activate` receives and where it is built
- [ADR 319](319-trust-line.md) — the first-party assertion in step 1
- ADR 025 — the journal; the record under which guarded activation was introduced

## Amendment — 2026-11-28: `API_VERSION` moves with the contract

Step 3 compared a manifest's `apiVersion` with a constant that had been `"0.2.0"` through 556
commits to the contract's sources, so it refused nothing (the gap recorded above). The
smallest policy that makes the check say something:

- **`API_VERSION` is `0.<generation>.<revision>`,** in `packages/plugin-sdk/src/version.ts`.
  It is not the package version: that one follows the engine's protocol and the release tag
  ([PM-0008](../../../../docs/adr/PM-0008-npm-packages-and-release.md), amendment 1).
- **The revision rises with every change to the contract's sources** (`plugin-api/src`,
  `plugin-sdk/src`), in the commit that moves plugin-sdk's package version. It started at 557.
- **The generation rises, and the revision returns to 0, with a change that breaks an
  extension written against the generation:** a member removed or renamed, a signature
  narrowed, a meaning changed. The wire types in `plugin-api/src/wire.d.ts` count.
- **The guard holds it.** `scripts/assert-contract-bumped.mjs` fails a range that changes the
  contract's sources and leaves `API_VERSION` not greater than it was. It cannot tell an
  addition from a break: which number moves is the author's call, and the review's.
- **What a manifest says.** `"^0.2"` accepts every host of generation 0.2, as before, so no
  existing manifest changes. `"^0.2.<n>"` also refuses a host older than revision `n`: an
  extension that uses surface added at revision `n` declares it, and an older host refuses
  the bundle at load with a message that says which side is behind
  (`explainApiMismatch`). A host of another generation refuses both forms.
- **`host.supports()` stays** the way to probe one door ([ADR 305](305-doors-always-present.md));
  the revision is the coarse floor, for a bundle that cannot run without what it uses.

Not done: the range grammar is still `*`, exact and caret; `paged-plugin init` still writes
`"^0.2"` (the CLI has no build step and does not read `version.ts`), so an author raises the
floor by hand. The reference is [`../reference/api-version.md`](../reference/api-version.md).
