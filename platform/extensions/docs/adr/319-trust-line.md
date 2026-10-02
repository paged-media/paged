# ADR 319 — The trust line: first-party bundles run in-process today; the isolate boundary is the real line

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `d90f727`;
  editor at `28dc764`.
- **Scope:** `loadBundle` in `packages/plugin-sdk/src/load.ts`; `BundleTrust` and the `trust`
  option in `packages/plugin-sdk/src/host-impl.ts`; what the in-process checks of
  [ADR 010](010-raw-mutate-gate-capability-enforcement.md) are and are not.

## Context

A bundle runs in the same JavaScript realm as the host application. `loadBundle` builds a
host object and calls the bundle's `activate` directly
(`packages/plugin-sdk/src/load.ts:84-104`). In that realm a bundle also holds `host.editor`,
"the raw editor handle", a member that "does not survive the isolate boundary"
(`packages/plugin-api/src/host.ts:1673-1679`).

The contract was shaped so that this can change without changing bundles. The host adapter
is one implementation of `BundleHost`; `DESIGN.md:87-93` describes the isolate migration as
"a *second implementation of the same interface*" over RPC, and `DESIGN.md:680-695` lists
which members can cross such a boundary as they are and which cannot.

Until then, the code says in several places what the in-process checks are for. The
manifest module calls them "HONESTY + accident-prevention, NOT a security boundary against
malicious code" (`packages/plugin-api/src/manifest.ts:25-27`), and `DESIGN.md:796-798` says
"the real boundary is the isolate".

On 2026-06-12, commit `3e1f02e` added an assertion at the load path; its message says that
none existed before. The comment gives the reason: the first-party constraint "is asserted
HERE", and not left to the convention that the host application only imports its own
bundles statically (`packages/plugin-sdk/src/load.ts:50-53`).

## Decision

Running a bundle in the host's realm is for first-party bundles only, and the loader says
so in code. Loading any other bundle is gated on three things the loader names: an isolate
or RPC host, enforced capabilities, and package signing. Trust is to be enforced at the
isolate boundary; the checks that exist today are in-process.

- `loadBundle` reads `options.trust`, which defaults to `"first-party"`, and throws for any
  other value. This is its first check, before the manifest id and the `apiVersion` range.
- The type `BundleTrust` has one member, `"first-party"`.
- The value is supplied by the host application, not by the bundle. The loader does not
  inspect the bundle to decide it.

What is enforced in-process today: the trust assertion above; the namespace rule and the
manifest capability gate at the host facade
([ADR 010](010-raw-mutate-gate-capability-enforcement.md)); and, for plugin metadata
writes, the adapter names the calling plugin to the engine so the engine checks the key as
well (`packages/plugin-sdk/src/host-impl.ts:1974-1990`).

What is not enforced, as the code itself states:

- The assertion does not authenticate a bundle. "there is no trustworthy signal ON the
  bundle yet (the `media.paged.*` id is self-asserted; signing is the last unchecked gate
  box), so the assertion is that the HOST declared first-party"
  (`packages/plugin-sdk/src/load.ts:54-57`).
- The capability gate is not a boundary: "a bundle holding the raw `host.editor` handle can
  still bypass the facade" (`packages/plugin-sdk/src/host-impl.ts:205-206`).
- A host may run the capability gate in `capabilityMode: "warn"`, in which a violation "is
  logged through `host.log.warn` and the call proceeds"
  (`packages/plugin-sdk/src/host-impl.ts:988-989`). The namespace gates stay loud.
- Three members cannot cross an isolate boundary in their current form: a tool's
  `gesture()` factory, a React panel component, and `host.editor` (`DESIGN.md:680-695`).

## Evidence

- `packages/plugin-sdk/src/load.ts:50-71` — the assertion, its comment and the error text
- `packages/plugin-sdk/src/host-impl.ts:814-829`, `:844-851` — `BundleTrust` and the `trust`
  option
- `packages/plugin-sdk/test/host-impl.spec.ts:357-389` — the default loads; another throws
- `packages/plugin-api/src/manifest.ts:20-30`,
  `packages/plugin-sdk/src/host-impl.ts:197-208` — the stated purpose of the capability gate
- `packages/plugin-api/src/host.ts:1673-1679`, `DESIGN.md:592-598` — `host.editor`
- `DESIGN.md:87-93`, `:680-695`, `:796-798` — the second implementation; the members that
  can and cannot be proxied; where the real boundary is
- `editor: apps/canvas/src/main.tsx:91-98`, `:1279-1285` — eight bundles imported
  statically; `loadBundle` called without a `trust` value, so the default applies

## Alternatives considered

Leaving the first-party constraint to convention is the state before commit `3e1f02e`; the
comment quoted under Context rejects it. Taking the trust signal from the bundle is ruled
out in `packages/plugin-sdk/src/host-impl.ts:819-822`: the manifest id "is SELF-ASSERTED —
a foreign bundle could claim it — so the trust signal cannot come from the bundle".

## Consequences

A host that wants to load a bundle it did not author has no supported path. Passing another
trust value throws, and the type admits none; the test has to cast to reach the check.
This repository contains no isolate host: `createBundleHostProxy` appears only as a name in
`DESIGN.md:93`. Of the three gates the loader names, capability enforcement exists in its
in-process form; a proxy host and a signature check do not exist here.

`DESIGN.md:50-54` gives the rule the boundary needs: state crosses as serializable
snapshots, and what cannot be cloned is a declared exception. `DESIGN.md:680-695` records
the three exceptions and an exit for each; the schema panel
([ADR 312](312-panels-as-data.md)) is the exit for React panels. `host.editor` is removed at
the boundary, so each remaining use of it in a plugin is work still to do
([ADR 315](315-isolation-contract.md)).

The error text and four comments point the reader to a document named
`plugin-trust-line.md`, which is not in this repository
(`packages/plugin-sdk/src/load.ts:69`). The gate checklist it refers to is
`docs/reference/trust-gate.md`.

## Related

- [ADR 010](010-raw-mutate-gate-capability-enforcement.md), [ADR 300](300-type-only-contract.md), [ADR 301](301-host-adapter-lives-in-plugin-sdk.md) — the in-process gate this ADR puts in context; why a second host implementation is possible
- [ADR 304](304-bundle-lifecycle.md), [ADR 312](312-panels-as-data.md), [ADR 315](315-isolation-contract.md), [ADR 318](318-host-spawned-workers.md) — the load sequence; the panel exit; the raw handle; a door with the same in-process stance
- [ADR 201](https://github.com/paged-media/editor/blob/main/docs/adr/201-plugins-as-pinned-packages.md) — how the editor compiles first-party bundles in
