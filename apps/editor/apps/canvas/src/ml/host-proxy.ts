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

// The same-origin route to the local generative host (editor ADR 290):
// `/api/ml/*` on the editor's own origin, forwarded to `paged-ml-host` on
// the loopback, as Claude goes through `/api/ai` (ADR 221). The browser
// never talks to another origin, so the network wall (`connect-src 'self'`)
// stays as it is.
//
// The dev server and `vite preview` mount it (vite.config.ts). The hosted
// playground cannot reach a user's machine: its Pages Function answers 503
// (functions/api/ml), and the Models panel says so.
//
// Not a relay: only `/api/ml/` paths, only the host's methods, no cookies
// or credentials forwarded, the target fixed by the server's environment
// (PAGED_ML_HOST_URL, a loopback URL), never by the request.

export const ML_HOST_DEFAULT_TARGET = "http://127.0.0.1:7861";

const METHODS = new Set(["GET", "PUT", "POST", "DELETE"]);
const FORWARDED = ["content-type", "accept", "last-event-id"];

/** The target from the environment, if it is a loopback http URL. */
export function mlHostTarget(env: string | undefined): string | null {
  const raw = env?.trim() || ML_HOST_DEFAULT_TARGET;
  try {
    const u = new URL(raw);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (u.protocol !== "http:" || !loopback || u.pathname !== "/") return null;
    return u.origin;
  } catch {
    return null;
  }
}

const problem = (status: number, error: string, message: string) =>
  new Response(JSON.stringify({ error, message }), {
    status,
    headers: { "content-type": "application/json" },
  });

export async function handleMlProxy(
  request: Request,
  options: { target: string | null; fetch?: typeof fetch },
): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/ml/"))
    return problem(404, "not_found", "not an /api/ml/ route");
  if (!METHODS.has(request.method))
    return problem(
      405,
      "method_not_allowed",
      `${request.method} is not allowed`,
    );
  if (!options.target)
    return problem(
      503,
      "unreachable",
      "local image model not running: PAGED_ML_HOST_URL is not a loopback http URL",
    );
  const headers = new Headers();
  for (const name of FORWARDED) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  const doFetch = options.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${options.target}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      ...(request.method === "PUT" || request.method === "POST"
        ? { body: await request.arrayBuffer() }
        : {}),
      redirect: "manual",
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (err) {
    return problem(
      503,
      "unreachable",
      `local image model not running: paged-ml-host does not answer at ${options.target} (${(err as Error).message})`,
    );
  }
  const out = new Headers();
  for (const name of ["content-type", "cache-control"]) {
    const v = res.headers.get(name);
    if (v) out.set(name, v);
  }
  return new Response(res.body, { status: res.status, headers: out });
}
