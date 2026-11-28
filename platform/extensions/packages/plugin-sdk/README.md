# @paged-media/plugin-sdk

The SDK for extensions of [Paged](https://paged.media), the page layout and
publishing editor. One package carries the three things an extension needs:

| Entry                         | What it is                                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@paged-media/plugin-sdk/api` | The contract, type-only: the manifest, the bundle lifecycle, the `BundleHost` surface an extension is handed, the contribution types and the engine's wire types. Nothing at run time. |
| `@paged-media/plugin-sdk`     | The runtime: `defineBundle`, `loadBundle`, the in-process host adapter, the fake editor and the headless host for tests, the API version check.                                        |
| `paged-plugin` (bin)          | The command line: scaffold an extension, validate a manifest, stamp and host its wasm. No dependencies, no build step.                                                                 |

`@paged-media/plugin-sdk/gesture-kit` holds the helpers for pointer tools, and
`@paged-media/plugin-sdk/api/manifest.schema.json` is the manifest's JSON
Schema.

The documentation is at [docs.paged.media/plugin-sdk](https://docs.paged.media/plugin-sdk/).

## Install

```sh
npm install --save-dev @paged-media/plugin-sdk @types/react
```

Declare `@paged-media/plugin-sdk` as a peer dependency of the extension: the
host provides the one copy at run time.

React is an optional peer (`react >=19.3`): the package loads without it, and
only an extension that renders panels with React needs it. `@types/react`
(`>=19.3`) is an optional peer as well, but a TypeScript project needs it,
because the contract's types name React's (the component a panel contributes).

## A minimal extension

`npx paged-plugin init my-plugin` writes this, with a test and a manifest:

```ts
import type { PluginManifest } from "@paged-media/plugin-sdk/api";
import { defineBundle } from "@paged-media/plugin-sdk";

import manifest from "./manifest.json" with { type: "json" };

export const bundle = defineBundle({
  manifest: manifest as PluginManifest,
  activate(host) {
    host.contribute.command({
      id: "com.example.hello.command.hello",
      title: "Say hello",
      handler: async () => {
        const meta = await host.document.meta();
        host.log.info(`hello: ${meta.pageCount} pages`);
      },
    });
    // The host takes down everything registered through it; dispose only
    // what you allocate outside it (timers, caches).
    return { dispose() {} };
  },
});
```

```json
{
  "id": "com.example.hello",
  "name": "hello",
  "version": "0.1.0",
  "apiVersion": "^0.2",
  "capabilities": { "document": { "read": "broad" } },
  "contributes": { "commands": ["com.example.hello.command.hello"] }
}
```

The manifest's `id` is reverse-DNS and prefixes every id the bundle registers.
A door the bundle uses must be declared under `capabilities`; the host refuses
an undeclared use. `npx paged-plugin validate manifest.json` checks the
manifest against the schema.

To test it without an editor, activate the bundle against the fake editor and
dispose it again:

```ts
import {
  createFakeEditor,
  loadBundle,
  mapBacking,
  silentConsole,
} from "@paged-media/plugin-sdk";

const fake = createFakeEditor();
const loaded = loadBundle(() => fake.editor, bundle, {
  console: silentConsole,
  storage: mapBacking(),
});
// fake.ids("commands") lists what the bundle registered.
loaded.dispose();
```

## Versions

Two numbers, with different jobs:

- **The package version**, `0.<protocol>.<patch>`, names the release. Its
  minor is the engine's wire protocol.
- **The API version**, `API_VERSION` (`0.<generation>.<revision>`), names the
  contract a host implements. A manifest's `apiVersion` is a range over it,
  and `loadBundle` refuses a bundle whose range the host does not satisfy.

The revision rises with every change to the contract and never takes anything
away. The generation rises when a change breaks an extension written against
it.

| `apiVersion` | Accepts                                          |
| ------------ | ------------------------------------------------ |
| `^0.2`       | every host of generation 0.2                     |
| `^0.2.557`   | hosts of generation 0.2 at revision 557 or later |

Name a revision when the extension cannot run without surface that revision
added; an older host then refuses it at load and says that the host is behind.
To keep running on older hosts, leave the floor low and probe each door with
`host.supports("area.member@major")`.

`host.editor`, the raw editor handle, is not part of the contract an extension
can build on: it follows the editor, not `API_VERSION`, and is removed when
bundles move into an isolate.

## Licence

`AGPL-3.0-only OR LicenseRef-PMEL`; see `LICENSE.md` and `LICENSE` in this
package.
