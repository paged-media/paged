# ADR 226 — Contribution types have one definition: the contract, extended by the shell

- **Status:** Accepted 2026-10-18.
- **Scope:** `packages/shell/src/registries/` (every contribution and registry type),
  `packages/shell/src/tools/{cursor,gesture-handler,tool-options}.ts`,
  `packages/shell/package.json`, `apps/canvas/src/plugin-api-compat.ts`; the two-way check in
  plugin-sdk (`platform/extensions/packages/plugin-sdk/src/harness.ts`,
  `checkManifestConformance`) and its run over the editor's bundles
  (`apps/canvas/test/contracts/bundle-registrations.test.ts`).

## Context

A plugin authors its contributions against `@paged-media/plugin-api`; the editor's shell
registers them. The shell did not import the contract. Each registry file declared its own
copy of each contribution type, and `apps/canvas/src/plugin-api-compat.ts` asserted, one
direction per type, that a contract contribution was assignable to the copy. That was a
leftover of separate repositories, where the shell could not depend on the contract; in one
repository it can (PM-0002).

The copies had drifted:

| Type | Only in the shell | Only in the contract | Different in both |
|---|---|---|---|
| `ToolContribution` | `cluster`, `description`, `status`, `legacyKey` | — | `gesture` returned the shell's `GestureHandler` |
| `PanelContribution` | `devOnly` | `source` (stamped by the SDK adapter, read by `PanelHost` through a cast) | — |
| `CommandContribution` | `args` | — | — |
| `KeybindingContribution` | `precedence` | — | — |
| `EditContextContribution` | — | — | `entry`: the shell still accepted `"command"`, removed from the contract (K-13); the shell's comment called `onContentWheel` "ahead of the contract", which had adopted it |
| `EditContextCandidate` | — | — | `metadata` spelled out inline instead of `PluginMetadataEnvelope` |
| `OverlayContribution`, `ObjectTypeContribution`, `ImporterContribution`, `ExporterContribution`, `ImportRequest`, `ExportResult`, `EnteredEditContext`, `ContentPointerEvent`, `ContentWheelEvent`, `PanelProps`, `OverlayProps`, `CursorSpec`, `ToolOptionsSpec` | — | — | identical copies |
| Menu item (`MenuRegistry.register`) | `groupLabel`, `disabled`, `labelFor`, `icon`, `accelerator`, `kind`; `when` widened to the string form | — | — |

The assertions caught a type that stopped being registrable. They did not catch a copy that
fell behind the contract, as `entry` and `onContentWheel` did.

## Decision

1. **The contract is the one definition.** Each shell type is the contract type itself
   (`export type OverlayContribution = Api.OverlayContribution`) or extends it with fields
   only the editor's own contributions set
   (`interface ToolContribution extends Api.ToolContribution { cluster?; description?;
   status?; legacyKey? }`). The names the editor imports did not change.
2. **Narrowing stays in the extension, and `extends` checks it.** The shell's
   `CanvasPointerEvent` narrows `target` to a DOM `EventTarget`. Its `GestureHandler` hands
   handlers the shell's richer `PagedEditor`. The menu item widens `when` through
   `Omit<…, "when">`, because the shell's own items may use the inert string form.
3. **Panel `source` is the contract's field.** The SDK adapter stamps it from the manifest
   (`host-impl.ts`, `contribute.panel`). It does not translate it, so the shell type accepts
   it as declared, and `PanelHost` reads it without a cast.
4. **The other direction is stated beside each extension.** `extends` proves a shell
   contribution is a contract contribution. A bundle's contribution arrives typed as the
   contract, so each extended type also states that the contract still registers unchanged:
   `export type _ToolRegistrable = Registrable<ToolContribution, Api.ToolContribution>`. It
   fails the shell's typecheck if the shell ever adds a required field. A registry's
   `register` cannot catch this, because TypeScript compares method parameters bivariantly.
   The same holds for `_PanelRegistrable`, `_CommandRegistrable`, `_KeybindingRegistrable`,
   `_MenuItemRegistrable` and `_ContractHandlerMountable`. The registry interfaces extend the
   contract's registry interfaces.
5. **Nothing flows back.** An editor-only field is not added to the contract to remove an
   extension. A field joins the contract only through API review, when a bundle needs it.
6. **`plugin-api-compat.ts` keeps the handle checks.** These are that the live `PagedEditor`
   satisfies the contract's, that the editor's tool-preview vocabulary is a superset, and the
   two binding-provider seam checks. The shell cannot see plugin-sdk, so those stay with the
   app. The nine contribution assertions became tautological, because the shell type now is
   the contract type, or moved next to the shell types. So did the gesture-event assertion.
   The shell declares `@paged-media/plugin-api` (`workspace:*`) in `dependencies`, as
   `packages/tools` and `apps/canvas` do. It is a type-only package.
7. **The manifest is checked both ways.** The SDK adapter refuses to register what a manifest
   does not declare. plugin-sdk's harness now also catches the opposite case, a declared id
   that is never registered. `checkManifestConformance(bundle, options)` activates the bundle
   against the recording headless host, in `'warn'` mode so that every undeclared
   registration is seen rather than only the first. It then plays an optional `drive` step
   and compares.
   - **Categories:** tools, panels (React and schema), commands, `capabilities.keybindings`,
     edit contexts, object types, importers, exporters, object-model kinds and typed
     commands.
   - **Report:** `{ declaredNotRegistered, registeredNotDeclared }` per category.
   - **Allowances:** an excused gap needs a per-bundle allowance with a reason. An allowance
     that no longer matches anything fails the check.

   `apps/canvas/test/contracts/` runs the check over every entry of the editor's bundle
   table. It names each `supports()` probe a bundle gates a registration on, and drives the
   one trigger no headless host has, slide's page doors, through a pages backend.
   `bun run test:bundle-contracts` runs it in the editor's `checks` job. It lives in the
   canvas app because that is the only package depending on all nine bundles, plugin-sdk and
   the engine. The lint zones keep modules and `platform/extensions` from importing bundles,
   and the root `tests/contracts/` has no package or CI task yet.

## Consequences

- The table above is now enforced by the compiler. The only fields left outside the contract
  are the shell-only optional ones listed in its first column. Every other field is the
  contract's.
- A contract change reaches the shell's own typecheck directly.
- All nine bundles pass the two-way check with no allowances. Their conditional registrations
  are listed in the spec, each next to the feature it waits on.

## Follow-ups

- The structural mirrors in `packages/shell/src/catalog/` (schema panels, binding providers,
  the object model) can derive from the contract the same way. The schema-panel and
  object-model mirrors depend only on plugin-api. The binding-provider host mirrors the
  plugin-sdk registry, so its check stays in the app.
- The contract's `MenuContribution.mode` (`"augment"` / `"replace"`) is accepted and dropped by
  the SDK adapter. No host field carries it.
- Candidates for API review, if a bundle needs them: `ToolContribution.description` (the
  rail's one-sentence tooltip) and `status: "planned"` (the honest-stub marker), and
  `CommandContribution.args` (typed payloads outside the object model).
