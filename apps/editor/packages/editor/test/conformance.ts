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

// The package's public types against the editor's own (plan E8): every
// value the published declarations promise is what the embedding API's
// sources give, and every config a host may pass is one they take. A
// change to the API that the contract in src/types.ts does not follow
// fails this typecheck (`bun run typecheck`), never a host's build.

import type * as Impl from "../../../apps/canvas/src/embed/index";
import type * as Connect from "../../../apps/canvas/src/embed/connect";
import type { PRESETS as ImplPresets } from "../../../apps/canvas/src/profiles/presets";
import type * as Public from "../src/types";

type Assignable<From, To> = [From] extends [To] ? true : false;
const ok = <T extends true>(): T => true as T;

// What the host passes: the public form fits the implementation's.
ok<Assignable<Public.EditorConfig, Impl.EditorConfig>>();
ok<Assignable<Public.HostActions, Impl.HostActions>>();
ok<Assignable<Public.ConnectConfig, Connect.ConnectConfig>>();

// What the host gets: the implementation's form fits the public one.
ok<Assignable<Impl.EditorHandle, Public.EditorHandle>>();
ok<Assignable<Impl.EditorEvent, Public.EditorEvent>>();
ok<Assignable<Impl.FieldValue, Public.FieldValue>>();
ok<Assignable<Connect.RemoteEditorHandle, Public.RemoteEditorHandle>>();
ok<
  Assignable<typeof ImplPresets, Readonly<Record<string, Public.EditorProfile>>>
>();
ok<Assignable<(typeof Impl.BRIDGED_METHODS)[number], Public.BridgedMethod>>();
ok<Assignable<Public.BridgedMethod, (typeof Impl.BRIDGED_METHODS)[number]>>();

// The functions the build's virtual modules stand for (src/virtual.d.ts).
type Runtime = typeof import("virtual:paged-editor/runtime");
type Iframe = typeof import("virtual:paged-editor/iframe");
ok<Assignable<typeof Impl.createEditor, Runtime["createEditor"]>>();
ok<Assignable<typeof Impl.mountEditor, Runtime["mountEditor"]>>();
ok<Assignable<typeof Impl.setDefaultFontUrls, Runtime["setDefaultFontUrls"]>>();
ok<Assignable<typeof Connect.connectEditor, Iframe["connectEditor"]>>();
