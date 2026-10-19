/*
 * This file is part of paged (https://paged.media).
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

// The page the wasm boots on: a blank document served cross-origin isolated
// (COOP same-origin, COEP require-corp, the editor's own policy), and the
// repository's files under `/@fs/<absolute path>`, as Vite's dev server
// serves them to the editor. Nothing outside the repository is served.

import { REPO_ROOT } from "./wasm-files";

const ISOLATED = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
};

const TYPES: Record<string, string> = {
  wasm: "application/wasm",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
};

export interface PageServer {
  /** The blank page's URL. */
  url: string;
  /** Every path the server answered, in order. */
  served: string[];
  stop(): void;
}

export function startPageServer(): PageServer {
  const served: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      served.push(path);
      if (path === "/")
        return new Response(
          // An empty icon, or Chrome asks for /favicon.ico after the load and
          // logs its 404 as a console error in whichever check runs then.
          '<!doctype html><meta charset=utf-8><link rel="icon" href="data:,"><title>wasm boot</title>',
          { headers: { ...ISOLATED, "content-type": "text/html" } },
        );
      if (path.startsWith("/@fs/")) {
        const fs = path.slice("/@fs".length);
        if (!fs.startsWith(`${REPO_ROOT}/`) || fs.includes("/../"))
          return new Response("outside the repository", { status: 403 });
        const file = Bun.file(fs);
        if (await file.exists()) {
          const ext = fs.slice(fs.lastIndexOf(".") + 1);
          return new Response(file, {
            headers: {
              ...ISOLATED,
              "content-type": TYPES[ext] ?? "application/octet-stream",
            },
          });
        }
      }
      return new Response("not found", { status: 404, headers: ISOLATED });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    served,
    stop: () => void server.stop(true),
  };
}
