/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// `@paged-media/editor` (docs/adr/PM-0013): the editor, embeddable.
//
//   import { createEditor } from "@paged-media/editor";
//   import "@paged-media/editor/style.css";
//
//   const editor = await createEditor(element, { profile: "template-fill" });
//
// This entry is small: the editor itself loads on the first call, so a page
// pays for it only when it mounts one. The page must be cross-origin
// isolated (COOP `same-origin`, COEP `credentialless` or `require-corp`):
// the engine shares memory with its worker. On a page that is not, the call
// loads nothing and rejects with an `EditorError` of code
// `notCrossOriginIsolated`, whose message names the iframe path.

import { assetBase, setAssetBase } from "./asset-base.js";
import type {
  EditorConfig,
  EditorError,
  EditorHandle,
  MountedEditor,
  MountOptions,
} from "./types.js";
import fonts from "virtual:paged-editor/fonts";
import * as errors from "virtual:paged-editor/errors";

export type * from "./types.js";

type Runtime = typeof import("virtual:paged-editor/runtime");

/** The engine's wasm: the host's, else the `@paged-media/paged` dependency's. */
function engineWasm(config: { engineWasm?: string }): string {
  const base = assetBase();
  return (
    config.engineWasm ??
    (base ? `${base}paged_canvas_wasm_bg.wasm` : __PAGED_ENGINE_WASM__)
  );
}

async function runtime(config: { assetBase?: string }): Promise<Runtime> {
  errors.assertEmbeddable();
  setAssetBase(config.assetBase);
  const rt = await import("virtual:paged-editor/runtime");
  const base = assetBase();
  rt.setDefaultFontUrls(
    base
      ? {
          roman: `${base}fonts/Inter.ttf`,
          italic: `${base}fonts/Inter-Italic.ttf`,
        }
      : fonts,
  );
  return rt;
}

/** Whether `value` is an error the editor refused with (`EditorError`):
 *  branch on its `code`. Structural, so it holds for an error from a frame. */
export function isEditorError(value: unknown): value is EditorError {
  return errors.isEditorError(value);
}

/**
 * Mount an editor into `element` and resolve, once its bundles and the first
 * document are up, to the handle the host drives it by.
 */
export async function createEditor(
  element: HTMLElement,
  config: EditorConfig = {},
): Promise<EditorHandle> {
  const rt = await runtime(config);
  return rt.createEditor(element, {
    ...config,
    engineWasm: engineWasm(config),
  });
}

/**
 * The lower level: mount an editor without the handle (no document, no
 * field values, no events). Most hosts want `createEditor`.
 */
export async function mountEditor(
  element: HTMLElement,
  options: MountOptions = {},
): Promise<MountedEditor> {
  const rt = await runtime(options);
  const mounted = rt.mountEditor(element, {
    ...(options.profile ? { profile: options.profile } : {}),
    actions: options.actions ?? {},
    library: false,
    engineWasm: engineWasm(options),
    ...(options.storage ? { storage: options.storage } : {}),
  });
  return { dispose: () => mounted.dispose() };
}
