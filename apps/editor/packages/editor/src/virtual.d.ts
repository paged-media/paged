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

// The build's virtual modules (vite.config.lib.ts): the editor's embedding
// API, compiled into this package from the editor's sources
// (apps/canvas/src/embed), typed here by the package's public contract.
// test/conformance.ts checks the sources against these types.

declare module "virtual:paged-editor/runtime" {
  type EditorConfig = import("./types").EditorConfig;
  type EditorHandle = import("./types").EditorHandle;
  type HostActions = import("./types").HostActions;
  type EditorProfile = import("./types").EditorProfile;
  export function createEditor(
    element: HTMLElement,
    config?: EditorConfig,
  ): Promise<EditorHandle>;
  export function mountEditor(
    element: HTMLElement,
    options?: {
      profile?: string | EditorProfile;
      actions?: HostActions;
      library?: boolean;
      engineWasm?: string;
    },
  ): { dispose(): void };
  export function setDefaultFontUrls(urls: {
    roman: string;
    italic: string;
  }): void;
}

declare module "virtual:paged-editor/iframe" {
  type BridgedMethod = import("./types").BridgedMethod;
  type ConnectConfig = import("./types").ConnectConfig;
  type RemoteEditorHandle = import("./types").RemoteEditorHandle;
  export function connectEditor(
    iframe: HTMLIFrameElement,
    config?: ConnectConfig,
  ): Promise<RemoteEditorHandle>;
  export const BRIDGED_METHODS: readonly BridgedMethod[];
}

declare module "virtual:paged-editor/presets" {
  type EditorProfile = import("./types").EditorProfile;
  export const PRESETS: Readonly<Record<string, EditorProfile>>;
}

/** The default faces the package ships (dist/fonts/). */
declare module "virtual:paged-editor/fonts" {
  const fonts: { roman: string; italic: string };
  export default fonts;
}

/** The engine's wasm in the `@paged-media/paged` dependency, relative to
 *  the module that reads it (replaced by the build). */
declare const __PAGED_ENGINE_WASM__: string;
