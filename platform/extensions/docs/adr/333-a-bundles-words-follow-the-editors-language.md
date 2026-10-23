# ADR 333 — A bundle's words follow the editor's language

- **Status:** Accepted 2026-10-23.
- **Scope:** `packages/plugin-api/src/host.ts` (`StringsSurface`, `MessageParams`,
  `BundleHost.strings`), `packages/plugin-sdk/src/strings.ts` (`StringsBacking`,
  `englishStrings`, `formatMessage`) and `host-impl.ts` (`CreateBundleHostOptions.strings`,
  `supports("strings@1")`). The editor side is `apps/editor/apps/canvas/src/plugin-host-options.ts`
  over the editor's catalogue (`platform/shared/strings`).

## Context

An embedding host chooses the editor's language (`createEditor({ locale })`), and the editor
and its built-in modules speak through one catalogue: each package defines its English beside
its code and ships its translations. The built-ins reach that catalogue directly; a community
extension sees only the contract (PM-0002), so its panels, commands and refusals would stay in
English in an editor that is not.

## Decision

`host.strings` is the contract's door to the editor's language:

- `define({ name: "English" })` defines the bundle's messages and answers their keys,
  `<manifest.id>.<name>`; a key defined again with other text throws.
- `translate(locale, { key: "…" })` registers the bundle's translation; a key outside its
  namespace throws, so no bundle can rewrite another's words or the editor's.
- `t(key, params)` answers the message in the editor's language, else its English. Messages
  take `{name}` parameters and one plural form
  (`{count, plural, one {# note} other {# notes}}`).
- `locale` names the editor's language.

The host wires a `StringsBacking`. Without one (a headless host, the Node CLI), the bundle's
English answers and `supports("strings@1")` is false: nothing pretends to translate.

## Consequences

- A bundle reads its words at render or registration time, as the built-ins do, never at
  module load, so it follows the language the host chose.
- Manifest titles stay data in English; a bundle shows its own titles through `t` where it
  registers contributions at runtime.
- The editor's catalogue holds the bundles' messages under their ids; the editor's strings
  guard checks the built-ins' German statically, and a community extension's coverage is its
  own.

## Related

- [ADR 329](329-plugins-contribute-a-typed-object-model.md): the contract's other door the
  editor shares with its bundles
