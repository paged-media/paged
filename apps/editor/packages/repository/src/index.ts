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

// @paged-media/repository — the local library of document repositories
// (core ADR 180). Framework-free; the app runs it in a worker
// (`serveLibrary`) and talks to it through `connectLibrary`.

export { memoryFs, opfsFs, type RepoFs } from "./fs.ts";
export {
  Library,
  parsePagedRef,
  RemoteError,
  type PagedRef,
  type CommitInfo,
  type Remote,
  type DocumentEntry,
  type EvidenceInfo,
  type LibraryOptions,
  type WasmRepository,
} from "./library.ts";
export { connectLibrary, serveLibrary, type LibraryClient } from "./rpc.ts";
export {
  accessToken,
  OAUTH_CHANNEL,
  signedInAs,
  signIn,
  signOut,
} from "./signin.ts";
export {
  connectLive,
  type LiveCall,
  type LiveConnection,
  type LiveState,
  type ToolContent,
  type ToolResult,
} from "./live.ts";
