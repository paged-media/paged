# ADR 312 — Panels cross the boundary as data: a schema plus bindings, no expression language

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `d90f727`.
- **Scope:** `packages/plugin-api/src/panel-schema.ts`, the `contribute.schemaPanel` and
  `bindings` members of `BundleHost`, `packages/plugin-sdk/src/schema-panel.tsx`

## Context

A panel registered through `contribute.panel` carries a React component. `DESIGN.md`
section 6 lists what could not be sent to a plugin running in another realm, and that
component is one of three such members: "v0 exception (expert-leaf escape hatch, same-realm
only)" (`DESIGN.md:682-695`).

A declarative panel needs a way to show, hide and disable rows. An earlier concept used
conditional expressions (`visibleWhen`, `enabledWhen`). `DESIGN.md:855-862` records that
this was "*rejected by design*: the editor catalog's binding ceiling is
`literal | selectionProperty` (+ coerce) — no expression language, and the SDK must not
fork one".

## Decision

A bundle can register a panel as data: a `PanelSchema` of sections and rows that name
widgets from the editor's catalog, through `contribute.schemaPanel`. Whatever changes at
run time is a named value the bundle publishes through `host.bindings`; the host looks the
name up and evaluates nothing.

- A row's `visible` and `enabled`, and a section's `visible`, are a `SchemaGate`:
  `boolean | { bind, negate? }`. `resolveGate` gives `true` for an absent gate, a literal as
  it is, and `Boolean(lookup(bind))`, inverted under `negate`; an unpublished name is `false`.
- A widget's `value` is a `WidgetValueBinding`: a `literal`, or a `selectionProperty` with
  one property path. It cannot be a published binding.
- A list row (the `paged.list` widget) takes its items from a named document collection or
  a published array. A row action dispatches a command or writes one property path.
- `host.bindings` is a per-bundle in-memory map with `publish`, `get`, `delete` and
  `onDidChange`. The schema door is gated like `contribute.panel`: the namespace rule, then
  the id must be in `contributes.panels[]`.
- The adapter turns the schema into a registry panel whose component delegates to a
  renderer the host application injects. With no renderer it registers a placeholder that
  says the panel "needs a host renderer", and `supports("schemaPanel.renderer@1")` is false.

## Evidence

- `packages/plugin-api/src/panel-schema.ts:80-115`, `:214-289` — value binding, binding
  reference, gate; rows, sections, the schema and the contribution
- `packages/plugin-api/src/panel-schema.ts:149-203` — list items, row actions, the list spec
- `packages/plugin-sdk/src/schema-panel.tsx:70-78`, `:81-116` — `resolveGate`; the component
  and the placeholder
- `packages/plugin-sdk/src/host-impl.ts:1265-1306`, `:2337-2357`, `:3105-3107` — the door;
  the bindings store; the renderer flag
- `packages/plugin-api/src/host.ts:1535-1549` — `BindingsSurface`
- `DESIGN.md:682-695`, `:855-862`, `:927-952` — the clonability table; the rejection; the limits
- `editor: apps/canvas/src/main.tsx:1266` — the editor injects its renderer
- `plugin-draw: packages/draw-bundle/src/activate.ts:193-195` — two schema panels registered

## Alternatives considered

A conditional binding language in the schema: rejected as quoted above. Binding a widget's
value to a published value: `DESIGN.md:944-948` leaves it as "a possible v2, not v1",
because the present rule "keeps every WRITE on the typed property door".

## Consequences

Conditional logic lives in the plugin. A gate cannot say `x && !y`; the bundle computes the
boolean and publishes it under a name (`packages/plugin-api/src/panel-schema.ts:56-59`). A
schema and its bindings are plain data, which the file header calls "the panel/overlay
ISOLATE EXIT the trust line needs" (`packages/plugin-api/src/panel-schema.ts:42-48`).
`DESIGN.md:949-952` describes an isolated host as "a SECOND `SchemaPanelRenderer`
implementation, not a contract change"; this repository declares the `SchemaPanelRenderer`
type (`packages/plugin-api/src/panel-schema.ts:317`) and contains no implementation of it;
the one the editor injects is in-process React.

The widget ids of the editor's catalog become part of what a bundle depends on. An unknown
id renders a placeholder (`packages/plugin-api/src/panel-schema.ts:215-217`). The value
binding type is a hand-written mirror of the editor's catalog binding
(`packages/plugin-api/src/panel-schema.ts:72-78`); the editor asserts at compile time that
its renderer fits the contract type (`editor: apps/canvas/src/main.tsx:130-136`).

React panels remain and are the common case. Of the shipped bundles only plugin-draw
registers schema panels, for two of its ten panels; its other eight and every panel of
plugin-web, plugin-image, plugin-sheets, plugin-data and plugin-doc are React components
registered through `contribute.panel`.

A comment contradicts the code: `packages/plugin-api/src/panel-schema.ts:258-262` says a
schema is registered "through `contribute.panel` exactly like a React `PanelContribution`";
the door is the separate `contribute.schemaPanel`.

## Related

- [ADR 300](300-type-only-contract.md), [ADR 319](319-trust-line.md) — why data, not components, is the direction; the boundary this is meant to survive
- [ADR 305](305-doors-always-present.md) — the door exists without a renderer; `supports()` reports it
- [ADR 204](https://github.com/paged-media/editor/blob/main/docs/adr/204-declarative-property-panels.md) — the editor's catalogue and its binding ceiling
- [ADR 023](https://github.com/paged-media/editor/blob/main/docs/adr/023-shared-panels-binding-providers.md) — a later, separate mechanism: host-owned panels fed by plugins
