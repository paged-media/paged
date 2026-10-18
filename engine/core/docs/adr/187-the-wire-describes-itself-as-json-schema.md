# ADR 187 — The wire describes itself as JSON Schema

- **Status:** Accepted 2026-10-18.
- **Scope:**
  - `crates/paged-wire`: the `schema` feature, `src/schema.rs`, `examples/emit-schema.rs` and
    the committed `schema/mutation.schema.json`.
  - `crates/paged-mutate`: the `schema` feature and `src/schema.rs`.
  - `platform/extensions/scripts/gen-core-commands.mjs`, which reads the schema.
  - `.github/workflows/core-ci.yml` and Moon's `core:wire-schema`, which check it.
  - No wire or protocol change. No wasm build turns the feature on. The four wasm packages keep
    their sizes and their code; their data differs only in the line numbers of three panic
    locations, which the added attribute lines move.

## Context

`paged_wire::Mutation` and every type it carries derive `Tsify`. tsify writes their
TypeScript into the canvas-wasm package's `.d.ts`, and the extension SDK vendors that file as
`platform/extensions/packages/plugin-api/src/wire.d.ts`
([plugin-sdk ADR 302](../../../../platform/extensions/docs/adr/302-vendored-wire-types.md)).

The SDK's typed core commands (`core.<op>`,
[DESIGN.md §21.12](../../../../platform/extensions/DESIGN.md)) are generated from the wire:
`scripts/gen-core-commands.mjs` turns each `Mutation` arm into a row of argument types. It
read the arms by parsing `wire.d.ts`, a 3,700-line generated file, with the TypeScript
compiler's JavaScript API. The engine had no description of its wire that a tool could read
without parsing TypeScript.

TypeScript 7, which the repository is adopting, has no JavaScript compiler API. Keeping the
script meant pinning a second, older TypeScript for one script.

## Decision

1. **Rust writes a JSON Schema of the wire.** `schemars` (1.x, MIT) is an optional dependency
   of `paged-wire` and `paged-mutate`, enabled by a `schema` feature on each.
   `#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]` sits next to the `Tsify`
   derive of each of the 27 types in `Mutation`'s closure: 5 in `paged-wire` (`PageId`,
   `ElementId`, `TextCellAddr`, `ByteBuf`, `Mutation`) and 22 in `paged-mutate`. `paged-wire`'s
   `schema` turns on `paged-mutate?/schema`, so it never turns on `mutations`: the read-only
   viewer, which takes `paged-wire` without default features, cannot reach the mutation
   crates through it.
2. **The schema is the deserialize contract, with its differences from the TypeScript
   stated.** It describes what the engine accepts. An `Option` field without
   `#[serde(default)]` is `x: T | null` without `?` in TypeScript, but serde reads it absent,
   so the schema does not require it; such a field is nullable, not required and has no
   `default`. `Value::Text`, `Enum` and `Ref` accept `null` for the empty string. `Set.address`
   is a string, as in the TypeScript. The deprecated protocol-70 target object that the engine
   still parses there is left out. `crates/paged-wire/src/schema.rs` lists these differences.
3. **The schema carries what the TypeScript carried, through schemars attributes.** Types are
   named in `$defs` by their Rust name, which is also the name tsify uses. Properties keep
   declaration order (`preserve_order`). A unit enum with only some variants documented takes
   `paged_mutate::schema::declaration_order`, because schemars otherwise groups the
   undocumented variants first (`PropertyPath` is the one case). A field whose default
   `skip_serializing_if` would skip states it with `extend("default" = null)`
   (`insertField.contentOffset`), because schemars leaves that default out. `Set.address` is
   `with = "String"`.
4. **The schema is a committed, checked artifact**, like `catalog.json`.
   `cargo run -p paged-wire --features schema --example emit-schema >
   crates/paged-wire/schema/mutation.schema.json` writes it.
   `the_committed_schema_is_current` fails when the file differs from the types and prints the
   command. Core CI runs the feature's tests and clippy in the `check` job; Moon runs them as
   `core:wire-schema`.
5. **Parity with tsify is a Rust test.**
   `the_schema_and_tsify_declare_the_same_ops_and_fields` reads tsify's own declaration of
   `Mutation` (`<Mutation as Tsify>::DECL`, the string the `.d.ts` is made of) with a narrow
   reader of its one regular line, and compares it with the schema. The ops, each op's fields
   in order, and each field's presence must match. Presence is required, `?`, or required but
   nullable. A failure lists every difference. Running this test against the types themselves,
   in the engine's CI, means a change cannot pass core and fail only later in the extension
   SDK. `sync-wire --check` in the extensions CI keeps the vendored `wire.d.ts` equal to that
   declaration. A third test fails a unit enum whose variants schemars would reorder.
6. **The typed core commands are generated from the schema.** `gen-core-commands.mjs` reads
   the JSON and keeps its own mapping: the id fields and their ADR 131 address kinds, fixed
   numeric tuples to point / bounds / transform, string enums to `enum`, named structs to open
   structs with a `shape`, other unions to opaque structs, and `nullFill` for the required but
   nullable fields. A schema form the mapping does not know fails the run. Its output,
   `core-commands.generated.ts`, was byte-identical to the TypeScript-parsing version's when
   the switch was made. The script no longer imports `typescript`.

## Consequences

- The wire has a description any tool can read as JSON, generated from the types the engine
  deserializes, so it cannot describe a wire the engine does not accept.
- `gen-core-commands.mjs` needs no TypeScript parser, so the TypeScript 7 migration does not
  have to keep an older TypeScript for it.
- Changing a type the wire carries now also means regenerating `mutation.schema.json` and, if
  the change is visible to commands, `core-commands.generated.ts`. Core CI fails until the
  schema is regenerated; the extensions CI fails until the commands are.
- A builder of `paged-wire --features schema` gets `serde_json` with `preserve_order` for its
  whole build. Nothing else turns the feature on, and no wasm build does.
- The schema keeps the doc comments as `description`s, so it doubles as reference text.
- The header of `core-commands.generated.ts` still names `wire.d.ts` as its source. The file
  is plugin-contract source, so any byte of it changes only with a contract version bump; the
  header moves with the next one. What it declares is what `wire.d.ts` declares, which the
  parity test holds.
- Follow-ups this enables, none built yet:
  - runtime validation of command arguments in the plugin SDK against the schema, beside the
    `ValueType` check;
  - typed tool `input_schema`s for `@paged-media/ai`, one per op, taken from the schema
    instead of hand-written;
  - generated reference pages for the mutation vocabulary on docs.paged.media.

## Evidence

- `crates/paged-wire/Cargo.toml`, `crates/paged-mutate/Cargo.toml` — the `schema` features
- `crates/paged-wire/src/schema.rs` — `mutation_schema`, the staleness, parity and order tests
- `crates/paged-mutate/src/schema.rs` — `declaration_order`
- `crates/paged-wire/examples/emit-schema.rs`, `crates/paged-wire/schema/mutation.schema.json`
- `platform/extensions/scripts/gen-core-commands.mjs`
- `.github/workflows/core-ci.yml` — `wire schema`; `moon.yml` — `wire-schema`
