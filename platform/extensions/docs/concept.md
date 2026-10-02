# Concept

Why this repository exists, what it is for, and what it will never do. This page states
intent, and each paragraph names its source in a comment. What is built today is in
[`status.md`](status.md); the long description is [`../DESIGN.md`](../DESIGN.md).

## Why it exists

The Paged editor is extended by plugins that are built outside the editor's repository. This
repository holds the contract between the editor and a plugin, and the tooling around it.
Two first-party plugins set the test the contract has to pass. `paged.draw` proves the
platform can host a tool: gestures, path mutations, overlays, panels. `paged.web` proves it
can host a foreign document model: a new object type, an embedded engine, diagnostics,
assets. The contract is meant to be the narrowest surface that lets both be built outside the
editor's repository. Everything else is left out on purpose.
<!-- source: README.md:3; DESIGN.md:15-22 -->

## What it is for

Three packages that change at three different rates. `@paged-media/plugin-api` is the
contract itself: the manifest, the bundle lifecycle and the host surface, as types only, to
be frozen at version 1. `@paged-media/plugin-sdk` is the runtime: the host adapter, the
loader, version negotiation and helpers; it moves faster. `plugin-cli` validates a manifest.
<!-- source: README.md:7-11; DESIGN.md:79-85 -->

The contract follows a small set of rules:

- **Types from the API, values from the host.** Every value a bundle touches at run time
  arrives through the host object at activation. Its module graph then holds no host code,
  so it can be unit-tested without React or wasm and can later run behind an isolate RPC.
- **Facades, not the object graph.** A bundle gets scoped facades that enforce the namespace
  rule and track every registration, not the editor's raw registries or engine client.
- **Teardown is structural.** Everything a bundle registers is disposable and is also
  tracked by the host, so disposing the bundle leaves the shell as it was found.
- **Snapshots and events.** State crosses the boundary as serializable snapshots; changes
  arrive through subscriptions. A write that is not applied is returned, not thrown.
- **Capability detection over version sniffing.** `host.supports()` answers "can I?" at run
  time; the manifest's `apiVersion` range answers "may I install?" at load.
- **One namespace rule, plus the capability gate.** Every contributed id starts with the
  manifest id, and a door a bundle uses must be declared in its manifest.
<!-- source: DESIGN.md:28-69 -->

The implementation of the host object lives in this repository, not in the editor; the
editor's part is one `loadBundle()` call per bundle. The stated reasons: the implementation
stays reviewable and versioned with the types it implements, and moving plugins into an
isolate becomes a second implementation of the same interface, not a change to the editor.
<!-- source: DESIGN.md:87-93; CLAUDE.md:46-52 -->

While the API version is `0.x`, breaking changes are allowed. A bundle declares the range
it was built for and `loadBundle` refuses a mismatch. The stated deprecation rule is that a
member leaves the surface only at a major version, with a deprecated release in between.
<!-- source: DESIGN.md:697-706 -->

## What it will never do

- **Grow ahead of need.** Nothing enters the surface speculatively: a type joins the
  contract when a real bundle needs it. <!-- source: DESIGN.md:24-26; CLAUDE.md:23-25 -->
- **Export a value from `plugin-api`.** A value export would pull host code into every
  bundle's module graph. <!-- source: CLAUDE.md:19-22 -->
- **Offer an ambient global** such as `paged.plugin.*`, or expose the editor's registries
  and engine client as the API. The first breaks teardown and isolate routing with several
  plugins; the second would freeze more than a hundred members by accident. `host.editor`,
  the raw editor handle, is a marked escape hatch that does not survive the isolate
  boundary. <!-- source: DESIGN.md:592-598, 710-713 -->
- **Keep a second history.** There is no plugin-side mutation queue and no plugin-local
  undo; the engine owns history. <!-- source: DESIGN.md:714-715 -->
- **Invent a panel expression language.** The binding vocabulary is the host catalogue's;
  the SDK does not fork it. <!-- source: DESIGN.md:716-717 -->
- **Fake a door.** A member the host cannot back is a visible seam, never something that
  looks interactive and does nothing. <!-- source: DESIGN.md:97-99, 914-917 -->
- **Give the CLI a dependency,** or claim the npm name `@paged-media/sdk`, which belongs to
  the engine's read-only viewer session. <!-- source: CLAUDE.md:41-45; README.md:16-18 -->
- **Load native code, or hand a wasm module the engine.** The compiled code a plugin ships
  is wasm, and a module never receives a host, client or editor handle. <!-- source: docs/reference/wasm-packaging.md:162-168 -->
- **Return a secret to a plugin.** The credential store has `set`, `exists` and `forget`,
  and deliberately no `get`. <!-- source: DESIGN.md:1311-1324 -->
- **Fetch on a plugin's behalf.** The network door grants consent per origin; the host does
  not proxy bytes, and a document does not fetch when opened. <!-- source: DESIGN.md:528-551 -->
- **Call the in-process gate a security boundary.** It keeps a manifest truthful about what
  a bundle touches; the real boundary is the isolate. <!-- source: DESIGN.md:793-798 -->
