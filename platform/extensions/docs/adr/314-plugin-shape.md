# ADR 314 — The plugin shape: semantics in Rust behind one wasm module, a logic-free shim, one published package

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `d90f727`;
  plugin repositories at plugin-sheets `71f37d7`, plugin-data `6b96ce5`, plugin-doc `76e1d06`,
  plugin-image `f7d21e5`, plugin-web `653a95e`, plugin-draw `0d12bf8`, plugin-publish `6994ad1`.
- **Scope:** how the first-party plugin repositories are built. Recorded here because every
  plugin depends on this repository; no code here enforces the shape.

## Context

The contract says what a bundle is at run time, a manifest and an `activate(host)` function
([ADR 304](304-bundle-lifecycle.md)), and not how a plugin is built. It provides for wasm:
the manifest has a `capabilities.wasm` list, and `docs/reference/wasm-packaging.md:208-235` describes
a wasm-bindgen module loaded by the bundle's own glue ([ADR 308](308-plugin-wasm.md)).

Three plugin repositories state one build shape as a hard rule in their `CLAUDE.md`, in
nearly the same words: all semantics are Rust crates compiled to one wasm module, the
TypeScript packages are "thin glue", and a bundle that seems to need an operation in
TypeScript is missing an API on the wasm crate. The three files state the rule and not its
reason. The repository does not record why.

They do record why the wasm crate has two layers. The exported class exists only for
`wasm32` "because `JsValue`-returning `#[wasm_bindgen]` methods compile only for wasm32",
and the plain-Rust session under it exists so that the conformance crate "exercises it
WITHOUT a wasm runtime" (`plugin-sheets: sheet-js/src/lib.rs:41-48`). In plugin-data a
native command-line tool drives the same session (`plugin-data: data-cli/Cargo.toml:25`).

On 2026-06-23 five plugin repositories were changed to publish one package each, with the
same commit body: "Inline the internal sub-package(s) into one published package (tsup
noExternal; wasm ships inside it); mark the internals private. One clean package per
plugin." (plugin-data `5b51165`, plugin-sheets `5331e4d`, plugin-web `ec23298`, plugin-draw
`0f75e82`, plugin-image `d86cf5c`).

## Decision

A content plugin is built in four parts.

1. **Rust crates hold the semantics.** One, `<name>-js`, compiles to the one wasm module.
2. **That crate is a shim.** A plain-Rust session type does the work; a class compiled only
   for `wasm32` forwards each call to it.
3. **A private TypeScript package** turns the engine's already-computed output into host
   mutations and holds hand-written mirrors of the Rust types.
4. **One npm package is set up for publishing:** the bundle with the private package
   inlined, the wasm and `manifest.json`. The contract is a peer
   ([ADR 307](307-contract-as-peer-dependency.md)). Registry state is not shown here.

| Plugin | 1. Rust semantics, one wasm | 2. Forwarding shim | 3. Private TS package | 4. Published |
|---|---|---|---|---|
| plugin-sheets | yes | `SheetEngine` over `SheetSession` | `sheet-host-model` | `@paged-media/sheet` |
| plugin-data | yes; a third-party wasm (DuckDB) is also booted, from TypeScript | `DataEngine` over `DataSession` | `data-host-model` | `@paged-media/data` |
| plugin-doc | yes | `DocEngine` over `DocSession` | `doc-host-model` | `@paged-media/doc` |
| plugin-image | yes | no: more than a hundred exported functions over state in thread-locals | none | `@paged-media/image` |
| plugin-web | a renderer crate with two exported functions | no | `web-model`, holding real logic | `@paged-media/web` |
| plugin-draw | no: TypeScript, plus two Rust crates for image tracing | no | `draw-geometry`, `draw-tools`, both real logic | `@paged-media/draw` |
| plugin-publish | no | no | none | `@paged-media/publish` and `@paged-media/pdf` |

plugin-image states no "all semantics in Rust" rule, and its glue holds one pixel algorithm
(quick selection) as a pure TypeScript module. plugin-web keeps its source model, sanitiser,
linter and CSS-flow scanner in `web-model`, which its own hard rule keeps free of
dependencies. plugin-draw is TypeScript by design ("Everything else in this repo is pure TS
on purpose"); the same comment calls shipping wasm "the established shape". In
plugin-publish the IDML bundle ships no wasm and "does NOT re-implement IDML", and the PDF
bundle keeps its heuristics in TypeScript beside a Rust mapper that "knows nothing about
PDF".

## Evidence

- `plugin-sheets: CLAUDE.md:77-84`, `plugin-data: CLAUDE.md:80-87`,
  `plugin-doc: CLAUDE.md:56-62` — the rule
- `plugin-sheets: sheet-js/src/lib.rs:35-48`, `plugin-data: data-js/src/lib.rs:42-48`,
  `plugin-doc: docx-js/src/lib.rs:21-23` — the session and the forwarding class
- `plugin-sheets: packages/sheet-host-model/src/index.ts:19-22`,
  `plugin-data: packages/data-host-model/src/index.ts:19-21`,
  `plugin-doc: packages/doc-host-model/src/index.ts:1-5` — the private translation package
- `plugin-sheets: packages/sheet-bundle/tsup.config.ts:7`,
  `plugin-data: packages/data-bundle/package.json:36-40` — inlining; what the package ships
- `.github/workflows/publish.yml` publishes one directory: plugin-sheets `:56`, plugin-data
  `:56`, plugin-doc `:48`, plugin-image `:56`, plugin-web `:60`, plugin-draw `:34`; every
  bundle directory in plugin-publish `:46`
- `plugin-image: image-js/src/lib.rs:98-138`, `plugin-image: glue/src/quick-select.ts:19-23`
  — exports over thread-local state; the TypeScript pixel algorithm
- `plugin-web: CLAUDE.md:17-19`, `plugin-web: packages/web-model/src/index.ts:19-24`,
  `plugin-web: packages/web-render/src/lib.rs:104-122` — the pure model; the two exports
- `plugin-draw: Cargo.toml:3-11`, `plugin-publish: packages/publish-bundle/src/io/idml.ts:19-21`,
  `plugin-publish: crates/pdf-import/src/lib.rs:24-27` — the repositories outside the shape

## Alternatives considered

Before 2026-06-23 the internal packages were published separately (the commit titles name
them, for example "was sheet-host-model/sheet-bundle"). The host's raw-module loader is
named and not used in five engine loaders ([ADR 308](308-plugin-wasm.md)).

## Consequences

An engine built this way is tested natively, without a browser or a wasm runtime, and can
be reused outside the editor. Each type that crosses the wasm boundary exists twice, in
Rust and as a hand-written TypeScript mirror, kept in step by hand. Nothing checks that
TypeScript stays free of semantics; the import lints say the rule is "enforced by review,
not by this lint" (`plugin-sheets: scripts/check-contract-imports.mjs:10-14`).

The private package is a test and type-check boundary, not a distributed one. plugin-sheets,
plugin-data and plugin-web import it by relative source path
(`plugin-data: packages/data-bundle/src/lower.ts:55`) so that the published type
declarations do not name a private package (plugin-data commit `012d58b`).

## Related

- [ADR 308](308-plugin-wasm.md), [ADR 307](307-contract-as-peer-dependency.md), [ADR 315](315-isolation-contract.md), [ADR 317](317-registry-driven-dispatch.md) — wasm loading; the contract as a peer; allowed dependencies; dispatch in three of the engines
- [ADR 350](https://github.com/paged-media/plugin-draw/blob/main/docs/adr/350-three-typescript-layers.md), [ADR 357](https://github.com/paged-media/plugin-draw/blob/main/docs/adr/357-image-trace-rust-lane.md) — the TypeScript plugin and its one Rust lane
- [ADR 651](https://github.com/paged-media/plugin-publish/blob/main/docs/adr/651-idml-compiled-into-engine-wasm.md), [ADR 654](https://github.com/paged-media/plugin-publish/blob/main/docs/adr/654-pdf-ir-and-mapper.md), [ADR 657](https://github.com/paged-media/plugin-publish/blob/main/docs/adr/657-one-bundle-per-format.md) — the foreign-format bundles
