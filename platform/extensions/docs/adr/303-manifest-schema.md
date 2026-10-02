# ADR 303 — The manifest is a closed-vocabulary schema; the CLI mirrors it without dependencies

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `d90f727`.
- **Scope:** `packages/plugin-api/src/manifest.schema.json`, `packages/plugin-api/src/manifest.ts`,
  `packages/plugin-cli/bin/paged-plugin.mjs`

## Context

Every bundle ships a `manifest.json`: its identity, the host doors it uses and the things it
contributes. The host's capability gate reads it at run time
([ADR 010](010-raw-mutate-gate-capability-enforcement.md)), and the documentation site
generates its plugin reference from the schema (`.github/workflows/notify-docs.yml:3-5`).

The allowed values have to exist in three forms: TypeScript unions in plugin-api, enums in a
JSON Schema, and runtime sets in the validator. One literal cannot feed all three: plugin-api
is type-only ([ADR 300](300-type-only-contract.md)), and the CLI may have no dependencies and
no build step (`packages/plugin-sdk/test/capability-vocabulary.spec.ts:15-25`).
`CLAUDE.md:44-45` states the CLI rule. The repository does not record why.

## Decision

`manifest.schema.json` defines a plugin manifest and is the declared single source of its
closed vocabularies. The TypeScript types and the CLI are projections of it, kept in step by
a test over eight vocabularies instead of by code generation.

- Four required identity fields (`id` in reverse-DNS form, `name`, `version`, `apiVersion`),
  an optional `publisher`, and two blocks: `capabilities` with 13 keys and `contributes`
  with 8.
- All 14 object schemas set `additionalProperties: false`. Document scopes, rendering
  surfaces, asset kinds, clipboard grants, wasm purposes, the edit-context entry gesture,
  baked fallbacks and part roles are enums; `gpu.realm` is a constant.
- Strings stay open where the plugin chooses a name: contribution ids, content type names,
  data-provider categories, a part's format.
- `paged-plugin validate` re-implements the schema by hand in one file with no dependencies,
  and adds what a schema cannot say: tool, command, importer and exporter ids, and panel ids
  that are not `*.panel.json` paths, must start with `<id>.`; referenced `*.panel.json` files
  must exist; wasm artifact names must be unique; wasm files on disk are measured against
  their ceilings and summed; `gpu.realm: "shared"` gets its own "reserved" message.

## Evidence

- `packages/plugin-api/src/manifest.schema.json:4` — the `$comment` naming this file the
  single source; `:7-13`, `:35-37`, `:236-238` — required fields and closed objects
- `packages/plugin-cli/bin/paged-plugin.mjs:4-9` — no dependencies, no build step, hand-rolled
  checks; `:21-25` the sets are projections of the schema
- `packages/plugin-cli/bin/paged-plugin.mjs:412-443` — the namespace rule and the panel-file
  check; `:297-303` the reserved realm; `:331-337`, `:344-368`, `:390-395` the wasm checks
- `packages/plugin-sdk/test/capability-vocabulary.spec.ts:119-128` — the eight vocabularies
- `packages/plugin-sdk/test/capability-manifest-cli.spec.ts:37-45` — tests drive the real CLI
  as a subprocess
- `packages/plugin-cli/package.json:1-25` — the package declares no dependencies
- `packages/plugin-api/src/manifest.ts:39-50` — the TypeScript mirror

## Alternatives considered

A generic JSON-Schema engine in the CLI was not used, to keep the CLI free of dependencies
(`packages/plugin-cli/bin/paged-plugin.mjs:6-8`). One runtime literal feeding all three
forms is ruled out by the two constraints in the Context.

## Consequences

A manifest can declare only what the contract models. Adding a capability means changing
the schema, `manifest.ts` and the CLI together. The test covers the eight vocabularies it
lists; part roles, required fields, numeric ranges and the unknown-key checks are mirrored
by hand and compared with the schema by no test.

The CLI's header says it mirrors the schema "1:1"
(`packages/plugin-cli/bin/paged-plugin.mjs:9`). It does not reject unknown keys inside
`capabilities.document`, `capabilities.dataProviders`, or the items of
`contributes.editContexts`, `objectTypes` and `partTypes`, which the schema forbids.
Nothing in this repo validates a manifest against the schema file itself; `loadBundle`
checks only the `id` pattern and `apiVersion` (`packages/plugin-sdk/src/load.ts:72-83`).

Comments and code disagree in places:

- `packages/plugin-api/src/manifest.ts:95-103` says the asset kind `"images"` is reserved and
  rejected; the schema and the CLI (`packages/plugin-cli/bin/paged-plugin.mjs:48-51`) accept it.
- The CLI header (`packages/plugin-cli/bin/paged-plugin.mjs:11-13`) names tool and command
  ids for the namespace rule; the code also covers importers, exporters and panels.
- `capabilities.editContext` is validated but "reserved, not yet wired"
  (`packages/plugin-api/src/manifest.ts:92-94`); the gate reads `contributes.editContexts`.
- Per `packages/plugin-api/src/manifest.ts`, `contributes.partTypes` is declarative only
  (`:359-369`) and `*.panel.json` paths are not interpreted by the host (`:325-327`).

## Related

- [ADR 010](010-raw-mutate-gate-capability-enforcement.md) — the gate that reads the manifest
- [ADR 308](308-plugin-wasm.md), [ADR 318](318-host-spawned-workers.md) — `wasm`, `workers`
- [ADR 019](https://github.com/paged-media/core/blob/main/docs/adr/019-capability-catalog-one-contract.md)
  — the record the vocabulary test cites
