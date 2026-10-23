# @paged-media/strings

Internal: the words the editor and the built-in modules show. Never published.

- A package defines its messages with their English text beside the code that
  shows them: `const M = defineMessages("templateForm", { empty: "…" })`, then
  `useStrings().t(M.empty)` in a component or `t(M.empty)` elsewhere.
- A locale catalogue (`locales/<locale>.json`, by key) overrides the English;
  a key it lacks falls back to the English. `{name}` parameters and one
  plural form (`{count, plural, one {# field} other {# fields}}`) are
  supported.
- The editor puts a catalogue in front of its components with
  `StringsProvider`, which also makes it the active catalogue for code that
  is not a component (two editors on one page share it). `loadLocale` takes
  the host's messages, the locales shipped here, or
  `<assetBase>/locales/<locale>.json`.
- `englishSource()` lists every defined key with its English text: the source
  a translation starts from. The editor's tests check that a shipped locale
  covers the keys of the parts it translates and names no key the code does
  not define.

Plan tasks E4 and E10 in `apps/editor/docs/composable-editor-plan.md`.
