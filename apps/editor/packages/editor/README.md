# @paged-media/editor

The paged editor, embeddable. `createEditor(element, config)` mounts the full editor, or one of
its presets (template filling, a form, a viewer, a solo tool), into an element of your page and resolves
to a handle you drive it by: load and save documents, fill a template's fields, export a PDF,
switch features, theme it, listen to its events. `@paged-media/editor/iframe` drives an editor
running in a frame instead.

```sh
npm i @paged-media/editor react react-dom
```

```ts
import { createEditor } from "@paged-media/editor";
import "@paged-media/editor/style.css";

const editor = await createEditor(document.getElementById("editor")!, {
  profile: "template-fill",
  document: { bytes: templateBytes, name: "card.paged" },
  actions: { submit: async () => send(await editor.save()) },
});
await editor.setFieldValues({ name: "Ada Lovelace" });
editor.on((event) => {
  if (event.type === "fieldChange") console.log(event.fields);
});
```

| Import                                  | What it is                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `@paged-media/editor`                   | `createEditor`, `mountEditor` and the types. The editor loads on the first call. |
| `@paged-media/editor/iframe`            | `connectEditor(iframe, config)`: the same handle, every method async. No React.  |
| `@paged-media/editor/presets`           | `PRESETS`, the preset profiles as data.                                          |
| `@paged-media/editor/style.css`         | The editor's stylesheet.                                                         |
| `@paged-media/editor/feature-ids.json`  | The ids a profile's `features` and `handle.features` take.                       |
| `@paged-media/editor/theme-tokens.json` | The design tokens `handle.setTheme({ tokens })` takes.                           |

## What the page needs

- **Cross-origin isolation.** The engine shares memory with its worker, so the page is served with
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`
  (or `require-corp`). There is no degraded mode: on a page that is not isolated, `createEditor`
  loads nothing and rejects with an `EditorError` of code `notCrossOriginIsolated`, whose message
  says what to do. A page that cannot serve the editor's files under those headers embeds it
  through `@paged-media/editor/iframe`: `connectEditor` drives the editor's `embed.html` on its
  own deployment, which sends its own headers. A frame is isolated only when its host page is, so
  that page still sends COOP `same-origin` and COEP `credentialless` (which asks nothing of its
  other resources), and the iframe allows `cross-origin-isolated` (`connectEditor` sets it).

  ```ts
  import { createEditor, isEditorError } from "@paged-media/editor";

  try {
    await createEditor(element, config);
  } catch (error) {
    if (isEditorError(error) && error.code === "notCrossOriginIsolated") {
      // serve the page with COOP and COEP, or use @paged-media/editor/iframe
    }
    throw error;
  }
  ```

- **React 19.3 or later** (a peer dependency): the editor renders with yours.
- **The engine**, `@paged-media/paged`, is a dependency at the same version; npm installs it.

## Phones and tablets

The `template-fill` and `form` presets work on phones and tablets (editor ADR 294). Below 720 px
of the editor's own width, `template-fill` gives the canvas the screen and opens the field tapped
on it in a sheet underneath, and `form` puts the form first with its preview folded away. Their
controls are 44 px touch targets there and on any coarse pointer; one finger pans the page, two
pinch, and zoom buttons sit over the canvas. A picture field offers the phone's camera
(`capture`) beside its library. A profile turns this off with `compact: null`; the full editor and
the solo presets keep their desktop layout at every width. The page that hosts the editor needs a
`<meta name="viewport" content="width=device-width, initial-scale=1">`.

## Assets

The package's modules name their files (chunks, workers, wasm, fonts) relative to themselves, in
the form bundlers read (`new URL("./file", import.meta.url)`). A host that bundles it with Vite,
webpack 5 or Rollup with an `import.meta.url` asset plugin gets every file copied into its own
output, the engine's wasm from `@paged-media/paged` included. With Vite, keep the package out of
the dev-server's dependency pre-bundling, which does not follow those references:

```ts
// vite.config.ts
export default {
  optimizeDeps: { exclude: ["@paged-media/editor", "@paged-media/paged"] },
};
```

A host that serves files itself copies `node_modules/@paged-media/editor/dist/` and
`node_modules/@paged-media/paged/paged_canvas_wasm_bg.wasm` into one directory and passes its URL:
`createEditor(element, { assetBase: "/paged-editor/" })`. `engineWasm` names the engine's wasm
alone. Workers must be same-origin with the page.

The paged.data bundle's engine (with its query store) is not in the package: the editor loads it
from `https://modules.paged.media` when a profile activates paged.data, and its loader from the
package's `dist/bin/` (beside its chunk, or under `assetBase`).

## Feature ids and deprecations

`@paged-media/editor/feature-ids.json` is the public list of the ids a profile's `features`,
`panels` and regions and `handle.features` name. An id leaves it only after a deprecation window
of at least two minor releases ([PM-0013](https://github.com/paged-media/paged/blob/main/docs/adr/PM-0013-editor-package.md),
amendment 2). The file's `deprecated` list names each old id, its replacement (or null), the
release that deprecated it and the first release without it. Until then the editor reads the old
id as its replacement (one without a replacement is ignored), warns once in the console and emits
`{ type: "idDeprecated", id, replacement, deprecatedIn, removeIn }` on `handle.on`. Each
release's notes on GitHub list the deprecated ids and the aliases that release removes.

```ts
editor.on((event) => {
  if (event.type === "idDeprecated")
    console.info(`${event.id} → ${event.replacement} before ${event.removeIn}`);
});
```

## Licence

`AGPL-3.0-only OR LicenseRef-PMEL`: see [LICENSE.md](./LICENSE.md). The default face, Inter, is
under the SIL Open Font License 1.1 (`dist/fonts/OFL-inter.txt`). Decision record:
[PM-0013](https://github.com/paged-media/paged/blob/main/docs/adr/PM-0013-editor-package.md).
