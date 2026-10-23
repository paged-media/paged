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

// The embedding API's public surface (docs/composable-editor.md §8): what
// `@paged-media/editor` exports (plan task E8).

export {
  createEditor,
  type EditorConfig,
  type EditorEvent,
  type EditorHandle,
  type FieldValue,
} from "./create-editor";
export { mountEditor, type MountOptions, type MountedEditor } from "../main";
export type { HostActions } from "../app/instance";
export { PRESETS } from "../profiles/presets";
export { connectEditor } from "./connect";
export type { ConnectConfig, RemoteEditorHandle } from "./connect";
export { BRIDGED_METHODS } from "./protocol";
export type { FrameConfig } from "./protocol";
// Where the default faces are served, for a build that ships them beside
// its modules (the `@paged-media/editor` package, PM-0013).
export { setDefaultFontUrls } from "@paged-media/shell";
