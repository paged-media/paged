# ADR 329 — Plugins contribute a typed object model; `host.objects` is the one registry

- **Status:** Accepted. Recorded retroactively on 2026-10-15 from the code at `0dab296`. First
  published in `@paged-media/plugin-api` and `@paged-media/plugin-sdk` 0.2.45-canary.0
  (2026-10-11, `2c22330`). The contract is described in full in
  [`DESIGN.md`](../../DESIGN.md) §21, with the panel rows in §12.7 and §12.8.
- **Scope:** `packages/plugin-api/src/object-model.ts`, `contribute.objectModel` and
  `BundleHost.objects` in `packages/plugin-api/src/host.ts`, `contributes.objectModel` in
  `packages/plugin-api/src/manifest.ts`, the property row in `packages/plugin-api/src/panel-schema.ts`;
  in `packages/plugin-sdk/src`: `object-registry.ts`, `object-address.ts`, `object-schema.ts`,
  `core-objects.ts` with `core-objects-v70.ts` and `core-objects-v71.ts`, `core-commands.ts`,
  `script-bridge.ts`, `panel-schema-check.ts`, `object-list.ts`, `value-edit.ts`, and the
  gates in `host-impl.ts`; `packages/plugin-cli/bin/paged-plugin.mjs` and
  `packages/plugin-cli/untyped-commands.baseline.json`.

## Numbering

The proposal for this decision was numbered 323, and the design notes and the code cite it as
"ADR 323". On the same day the record for page navigation and page images was accepted under
323 ([ADR 323](323-page-navigation-and-page-images.md)), and the object model was never
recorded in `docs/adr/`. This record takes the next free number in this repository's range.
A citation of "ADR 323" in `packages/*/src`, in the tests or in the untyped-commands baseline
means this record when it is about the object model; those citations change with the next
contract change (see Consequences). The proposal for the Node CLI kept its number:
[ADR 324](324-node-cli-over-the-headless-host.md).

Development used the versions 0.2.42 to 0.2.44 on a branch. The published 0.2.43-canary.0
carries page navigation and no object model, and 0.2.44 was never published.

## Context

Before the object model:

- A command took `payload: unknown`, so every handler narrowed its own payload by hand, and no
  door let anything but the editor run a command.
- Plugin state was reachable only through the plugin's own panels: image layers in a wasm layer
  stack, sheet cells in a wasm model, draw recipes in JSON parts, web sources in a label.
- A binding provider resolved core property paths only, and only while its edit context was
  active ([editor ADR 023](https://github.com/paged-media/editor/blob/main/docs/adr/023-shared-panels-binding-providers.md)).
- Core had four addressing schemes and dedicated property operations. Core
  [ADR 131](https://github.com/paged-media/core/blob/main/docs/adr/131-one-address-grammar-and-selectors.md)
  and [ADR 132](https://github.com/paged-media/core/blob/main/docs/adr/132-typed-property-schemas-and-virtual-paths.md)
  replaced them with one address grammar, typed property schemas and one
  `Set { address, path, value }`, at protocol 71.

A data binding, a script, a command line and a panel field all need to name an object and set
one of its properties, and they need to do it the same way for core objects and for plugin
objects.

## Decision

A plugin contributes its **object model**: kinds, addresses, typed property schemas,
get/set/list, and typed commands. The host merges core and every plugin into one registry,
`host.objects`. The editor, the headless host and the Node CLI inject it, and scripts,
bindings, panel fields and the CLI reach plugin objects only through it.

- **The contribution.** `host.contribute.objectModel({ kinds, commands, batch? })` returns an
  `ObjectModelHandle`: a `Disposable` whose `changed(addresses?)` announces changes the engine
  does not see. A kind is `{ kind, title, schema, content?, hostOf, list, get, set?, batch? }`.
  A plugin object's address is `plugin:<manifest id>/<kind>/<id>`. A typed command is
  `{ id, title, args: ValueType, result?, handler(ctx: { objects }, args) }`.
- **The registry.** `host.objects` offers `query`, `get`, `getAll`, `set`, `batch`, `schema`,
  `kinds`, `commands`, `invoke` and `onDidChange` over core addresses and every plugin's kinds.
  A read answers an `ObjectValue` (`value`, `mixed`, `absent`, or `refused` with a code). A
  write answers an `ObjectWriteResult` (`applied`, `undoSteps`, and on refusal a `code`,
  `reason` and the failing op's `index`). Expected failures are results; only `invoke` rejects,
  because a command returns arbitrary data.
- **Types are core's.** `ValueType` and `PropertySchema` rows are ADR 132's, so a plugin row and
  a core catalog row render through one schema-driven field. The address and selector grammar
  is a TypeScript mirror of core's (`object-address.ts`), held to it by round-trip properties and
  by every `idGrammar` example in the vendored catalog. An address is a session handle; nothing
  in the contract persists one.
- **One batch, one undo step.** A batch is validated against the schema (never coerced;
  `coerceValue` is the explicit door a text surface calls first), planned in full, and only then
  applied. Core ops become mutations. A plugin answers an `ObjectWrite`: `mutations`, `state`
  (content-addressed parts plus a label on the host element: the label-hash pattern), `both`,
  or `rejected`. Parts are written first, and every mutation and every label go to the engine
  as one `batch`. Undo reverts the label, and the plugin reloads the state the label names, so
  a plugin keeps no history of its own. A refusal anywhere applies nothing.
- **A plugin-level planner.** `ObjectModelContribution.batch(ops)` receives every write of a
  batch that targets any of the plugin's kinds, in batch order, so kinds that share state are
  planned together. Without it, two per-kind `state` writes on one host are refused rather than
  merged.
- **One label per plugin per host.** A `state` write's label key is exactly `x-paged:<plugin id>`
  with the envelope `{ v, data }`, or a sub-key `x-paged:<plugin id>.<sub>` that the registry
  merges into that envelope. Any other key is `denied`. A label may be hosted on a page item, a
  story, a page or the document.
- **The core seam is protocol-aware.** `createCoreObjects` feature-detects the engine. From
  protocol 71 core addresses go to core's `RequestGet`, `Set` and `RequestQuery`, and the rows
  are the vendored catalog's `propertySchemas`. Below 71 an interim table maps core kinds onto
  the older wire. Creates of core kinds (swatches, styles, text variables, layers, pages, frames)
  plan in the same batch, and `created[]` names every new object in op order, core and plugin
  creates alike.
- **Typed core commands.** Core's content and structure operations are typed commands named
  `core.<op>`, generated from the vendored wire types, so they share a batch and its undo step
  with sets, creates and deletes. A plugin command runs arbitrary code and cannot share a batch.
- **Scripts reach plugin objects.** At protocol 71 a `paged.*` script that names a `plugin:`
  address suspends; the host answers its calls (`get`, `batch`, `query`, `schema`, `invoke`,
  `commands`) through the one registry and reports the engine sequence numbers of the writes it
  made, so they fold into the script's undo step (`answerHostObjectsRound`).
- **Panels declare fields, not widgets.** A schema-panel row may be
  `{ field: "property", address, path, kind? }`. The host renders it with its schema-driven
  `PropertyField` over `host.objects`; a commit is one batch, and the field carries "Bind to
  data…". `validatePanelSchema`, `publishObjectList` and `planValueEdit` help a bundle declare,
  pick and edit such rows.

### Gates

- At run time, `contribute.objectModel` requires every kind and every typed command to be
  declared in `contributes.objectModel`; a kind with no rows, a row whose type is not a
  `ValueType`, or a repeated path is refused, and an inline manifest schema must name the same
  paths as the runtime rows. Reads need `document.read`; writes and `invoke` need
  `document.write`.
- `paged-plugin validate` applies the same rules to the manifest, with schema and argument files
  resolved relative to the bundle; a typed command without `args` fails.
- Untyped commands are a shrink-only baseline shipped with the CLI. `validate` fails a new
  untyped command of a plugin in the baseline, and the contract guard fails a commit that grows
  the baseline (`scripts/assert-untyped-shrinks.mjs`).
- `supports()` answers `contribute.objectModel@1` and `objects@1` always, and
  `objects.shared@1` when the host passes a shared registry.

## Evidence

- `packages/plugin-api/src/object-model.ts:58-64` — `Address` and `Selector`; `:234-251` —
  `ObjectValue` and `ObjectOp`; `:329-351` — `ObjectWrite`; `:379-430` — the kind, the typed
  command and the contribution with its plugin-level `batch`; `:441-458` — `ObjectWriteResult`
  with `created` and `commands`; `:494` — `ObjectsSurface`
- `packages/plugin-api/src/host.ts:558` — `contribute.objectModel`; `:2295` — `BundleHost.objects`
- `packages/plugin-api/src/manifest.ts:396-402`, `:418` — `contributes.objectModel`
- `packages/plugin-api/src/panel-schema.ts:306-372` — the property row and the row union
- `packages/plugin-sdk/src/object-registry.ts:206` — `createObjectRegistry`; `:488-510` — the
  label-key rule and the refusal of conflicting state writes; `:544-563` — parts first, then one
  commit
- `packages/plugin-sdk/src/object-address.ts:126`, `:200`, `:420` — `parseAddress`,
  `formatAddress`, `parseSelector`
- `packages/plugin-sdk/src/object-schema.ts:130`, `:329` — `validateValue`, `coerceValue`
- `packages/plugin-sdk/src/core-objects.ts:16-30`, `:126` — the protocol-aware seam
- `packages/plugin-sdk/src/core-commands.ts:54` — the operations that are not typed commands,
  each with its reason
- `packages/plugin-sdk/src/script-bridge.ts:70-79`, `:94-158` — the host half of the script
  bridge and the calls it answers
- `packages/plugin-sdk/src/host-impl.ts:199-200`, `:1985-2014`, `:4437-4457` — the flags, the
  declaration gate and the read and write gates
- `packages/plugin-sdk/src/panel-schema-check.ts:57`, `:258`; `object-list.ts:56`;
  `value-edit.ts:166` — the panel helpers
- `packages/plugin-cli/bin/paged-plugin.mjs:15-23`, `:175-190` — `validate` over
  `contributes.objectModel` and the untyped baseline
- Specs in `packages/plugin-sdk/test`: `object-model.spec.ts`, `object-model-core.spec.ts`,
  `object-model-v71.spec.ts`, `object-model-fixups.spec.ts`, `object-model-created.spec.ts`,
  `object-model-commands.spec.ts`, `object-model-cli.spec.ts`, `object-address.spec.ts`,
  `script-bridge.spec.ts`, `panel-schema-property.spec.ts`

## Consequences

- Every first-party bundle contributes an object model, and the bundles peer on a contract of
  0.2.45 or later.
- A binding, a script, the Node CLI and a panel field write a plugin property through the same
  validation and the same undo step as a core property.
- Typed commands replace untyped ones over time; `CommandContribution` keeps its untyped
  `handler(paged, payload?)` during the migration, and the baseline records what is left.
- The code, the tests, the untyped-commands baseline and a contract-guard step name cite this
  record as "ADR 323". A comment change under `packages/*/src` is a contract change that needs a
  version bump ([ADR 306](306-canary-releases.md)), so those citations change with the next
  contract release rather than on their own.
- Binding providers ([editor ADR 023](https://github.com/paged-media/editor/blob/main/docs/adr/023-shared-panels-binding-providers.md))
  keep working for panels inside an edit context; they are no longer the only way a plugin value
  becomes addressable.

## Related

- [ADR 324](324-node-cli-over-the-headless-host.md) — the Node CLI, the third host that injects
  `host.objects`
- [ADR 310](310-one-write-door.md) — one write door; a batch lands through it as one engine step
- [ADR 311](311-plugin-state-under-own-id.md) — plugin state under the plugin's own id; the label
  rule above is its form for `host.objects`
- [ADR 312](312-panels-as-data.md) — panels as data; the property row extends it
- Core [ADR 131](https://github.com/paged-media/core/blob/main/docs/adr/131-one-address-grammar-and-selectors.md)
  and [ADR 132](https://github.com/paged-media/core/blob/main/docs/adr/132-typed-property-schemas-and-virtual-paths.md)
  — addresses, selectors, typed schemas and `Set`
