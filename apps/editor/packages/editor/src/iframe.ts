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

// `@paged-media/editor/iframe` (docs/adr/PM-0013): the host's side of the
// iframe bridge. No React and no engine: the editor runs in the frame, on
// the editor's own deployment (`embed.html`), and this module only talks to
// it. The host page needs no isolation headers of its own beyond the ones
// the frame asks for (see `connectEditor`).

import type {
  BridgedMethod,
  ConnectConfig,
  RemoteEditorHandle,
} from "./types.js";
import * as bridge from "virtual:paged-editor/iframe";

export type {
  BridgedMethod,
  ConnectConfig,
  EditorEvent,
  FieldInput,
  FieldValue,
  HostActions,
  RemoteEditorHandle,
} from "./types.js";

/** Drive the editor in `iframe`: resolves once it is ready. */
export function connectEditor(
  iframe: HTMLIFrameElement,
  config: ConnectConfig = {},
): Promise<RemoteEditorHandle> {
  return bridge.connectEditor(iframe, config);
}

/** The handle's methods the bridge carries. */
export const BRIDGED_METHODS: readonly BridgedMethod[] = bridge.BRIDGED_METHODS;
