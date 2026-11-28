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
//
// The host answers only a caller that presents its access token
// (apps/ml-host/README.md). The proxy presents it for the page, so the
// proxy holds the host's guards itself: it serves only a request addressed
// to a loopback name (`Host`), and a browser request only from the page of
// that same origin (`Origin`, `Sec-Fetch-Site`). What the browser said about
// its origin is forwarded, so the host's own origin guard still applies.

export const ML_HOST_DEFAULT_TARGET = "http://127.0.0.1:7861";

const METHODS = new Set(["GET", "PUT", "POST", "DELETE"]);
const FORWARDED = [
  "content-type",
  "accept",
  "last-event-id",
  "origin",
  "sec-fetch-site",
];
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/** The target from the environment, if it is a loopback http URL. */
export function mlHostTarget(env: string | undefined): string | null {
  const raw = env?.trim() || ML_HOST_DEFAULT_TARGET;
  try {
    const u = new URL(raw);
    const loopback = LOOPBACK.includes(u.hostname);
    if (u.protocol !== "http:" || !loopback || u.pathname !== "/") return null;
    return u.origin;
  } catch {
    return null;
  }
}

type Env = Record<string, string | undefined>;

/** Where the host wrote its token: PAGED_ML_HOST_TOKEN_FILE, else beside
 *  the host's config (PAGED_ML_HOST_CONFIG, else the platform's config
 *  directory), `<config stem>.token`. */
export function mlHostTokenFile(
  env: Env,
  platform: string = process.platform,
): string | null {
  const set = (k: string) => env[k]?.trim() || null;
  const explicit = set("PAGED_ML_HOST_TOKEN_FILE");
  if (explicit) return explicit;
  const config = set("PAGED_ML_HOST_CONFIG");
  if (config) {
    const cut = Math.max(config.lastIndexOf("/"), config.lastIndexOf("\\"));
    const dot = config.lastIndexOf(".");
    return `${dot > cut + 1 ? config.slice(0, dot) : config}.token`;
  }
  const home = set("HOME");
  if (platform === "win32") {
    const base = set("APPDATA");
    return base ? `${base}\\paged\\ml-host.token` : null;
  }
  const base =
    platform === "darwin"
      ? home && `${home}/Library/Application Support`
      : (set("XDG_CONFIG_HOME") ?? (home && `${home}/.config`));
  return base ? `${base}/paged/ml-host.token` : null;
}

const TOKEN = /^[A-Za-z0-9._~-]{32,512}$/;

/** The host's access token: PAGED_ML_HOST_TOKEN, else the token file's
 *  content, read on each call (a restarted host has a new one). */
export async function mlHostToken(
  env: Env,
  readFile?: (path: string) => Promise<string>,
): Promise<string | null> {
  const given = env["PAGED_ML_HOST_TOKEN"]?.trim();
  if (given) return TOKEN.test(given) ? given : null;
  const path = mlHostTokenFile(env);
  if (!path) return null;
  try {
    const read =
      readFile ??
      (async (p: string) =>
        (await import("node:fs/promises")).readFile(p, "utf8"));
    const token = (await read(path)).trim();
    return TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}

const problem = (status: number, error: string, message: string) =>
  new Response(JSON.stringify({ error, message }), {
    status,
    headers: { "content-type": "application/json" },
  });

/** The host's guards, held here because the proxy presents the token: a
 *  loopback `Host`, and a browser request only from this same origin. */
function refusal(request: Request, url: URL): Response | null {
  if (!LOOPBACK.includes(url.hostname))
    return problem(
      403,
      "forbidden_host",
      "the local image model is reached only through a loopback address",
    );
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let host: string | null = null;
    try {
      host = new URL(origin).host;
    } catch {
      // "null" and other opaque origins
    }
    if (host !== url.host)
      return problem(
        403,
        "forbidden_origin",
        "the local image model answers only this page's own origin",
      );
  }
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none")
    return problem(
      403,
      "forbidden_origin",
      "the local image model answers only this page's own origin",
    );
  return null;
}

export async function handleMlProxy(
  request: Request,
  options: {
    target: string | null;
    fetch?: typeof fetch;
    /** The host's access token; resolved from the environment and the
     *  host's token file when left out, `null` for none. */
    token?: string | null;
  },
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
  const refused = refusal(request, url);
  if (refused) return refused;
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
  const token =
    options.token === undefined
      ? await mlHostToken(process.env)
      : options.token;
  if (token) headers.set("authorization", `Bearer ${token}`);
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
