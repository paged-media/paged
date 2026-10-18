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

// ADR 180 — the local library's worker: hashing and unzipping a large
// document on save stays off the main thread. It owns the origin-private
// file system and the repository wasm; the shell reaches it through
// `connectLibrary` (packages/repository/src/rpc.ts).
//
// Never the shell barrel here: it pulls in React, and a worker that loads it
// hangs at startup. @paged-media/repository's barrel is framework-free.

import init, { Repository } from "@paged-media/repo-wasm";
// The asset by explicit `?url`, as for the engine wasm (see main.tsx).
import repoWasmUrl from "@paged-media/repo-wasm/paged_repo_wasm_bg.wasm?url";
import { Library, opfsFs, serveLibrary } from "@paged-media/repository";

serveLibrary(
  self as unknown as Parameters<typeof serveLibrary>[0],
  async () => {
    await init({ module_or_path: repoWasmUrl });
    return new Library(await opfsFs(), {
      createRepository: (owner) => new Repository(owner),
    });
  },
);
