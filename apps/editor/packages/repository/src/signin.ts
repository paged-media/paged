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

// Signing in to a paged.server from the browser editor: an OAuth 2.1 public
// client (dynamic registration, PKCE S256), in a popup. Main thread only.
//
// The callback page answers over a BroadcastChannel, not `window.opener`: the
// editor is cross-origin isolated (COOP same-origin, for SharedArrayBuffer),
// and a popup that navigates to the server's origin loses its opener for good.
// The channel is same-origin, so only this editor's own callback page can
// speak on it.
//
// Tokens are kept in localStorage per server. The access token lives an hour
// and is refreshed with a rotating refresh token.

export const OAUTH_CHANNEL = "paged-oauth";

interface Tokens {
  access: string;
  refresh: string;
  expiresAt: number;
}

const key = (server: string, what: string) =>
  `paged.server.${new URL(server).origin}.${what}`;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function random(n = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

async function s256(verifier: string): Promise<string> {
  return b64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
}

function load(server: string): Tokens | null {
  try {
    const raw = localStorage.getItem(key(server, "tokens"));
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    return null;
  }
}

function store(server: string, t: Tokens | null): void {
  if (t) localStorage.setItem(key(server, "tokens"), JSON.stringify(t));
  else localStorage.removeItem(key(server, "tokens"));
}

async function clientId(server: string, redirectUri: string): Promise<string> {
  const cached = localStorage.getItem(key(server, `client:${redirectUri}`));
  if (cached) return cached;
  const resp = await fetch(`${server}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "paged editor",
      redirect_uris: [redirectUri],
    }),
  });
  if (!resp.ok)
    throw new Error(
      `the server refused to register this editor (${resp.status})`,
    );
  const id = ((await resp.json()) as { client_id: string }).client_id;
  localStorage.setItem(key(server, `client:${redirectUri}`), id);
  return id;
}

async function exchange(
  server: string,
  form: Record<string, string>,
): Promise<Tokens> {
  const resp = await fetch(`${server}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const body = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!resp.ok || !body.access_token || !body.refresh_token) {
    throw new Error(`sign-in failed: ${body.error_description ?? resp.status}`);
  }
  return {
    access: body.access_token,
    refresh: body.refresh_token,
    // A minute early, so a call never leaves with a token about to lapse.
    expiresAt: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000,
  };
}

/** Signs in to `server` in a popup and keeps the tokens. */
export async function signIn(server: string): Promise<void> {
  server = server.replace(/\/$/, "");
  const redirectUri = `${location.origin}/oauth-callback.html`;
  const id = await clientId(server, redirectUri);
  const verifier = random(48);
  const state = random(16);
  const url = new URL(`${server}/oauth/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: id,
    redirect_uri: redirectUri,
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
    state,
    scope: "paged",
  })) {
    url.searchParams.set(k, v);
  }
  const channel = new BroadcastChannel(OAUTH_CHANNEL);
  const answer = new Promise<{ code?: string; error?: string }>(
    (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("sign-in timed out")),
        5 * 60_000,
      );
      channel.onmessage = (
        e: MessageEvent<{ state?: string; code?: string; error?: string }>,
      ) => {
        if (e.data?.state !== state) return;
        clearTimeout(timer);
        resolve(e.data);
      };
    },
  );
  if (
    !window.open(url.toString(), "paged-signin", "popup,width=520,height=680")
  ) {
    channel.close();
    throw new Error("the sign-in window was blocked");
  }
  try {
    const { code, error } = await answer;
    if (!code)
      throw new Error(`sign-in was not completed (${error ?? "no code"})`);
    store(
      server,
      await exchange(server, {
        grant_type: "authorization_code",
        code,
        client_id: id,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    );
  } finally {
    channel.close();
  }
}

/** A current access token for `server`, refreshing it when it has lapsed; null when signed out. */
export async function accessToken(server: string): Promise<string | null> {
  server = server.replace(/\/$/, "");
  const t = load(server);
  if (!t) return null;
  if (Date.now() < t.expiresAt) return t.access;
  const redirectUri = `${location.origin}/oauth-callback.html`;
  const id = localStorage.getItem(key(server, `client:${redirectUri}`));
  if (!id) return null;
  try {
    const next = await exchange(server, {
      grant_type: "refresh_token",
      refresh_token: t.refresh,
      client_id: id,
    });
    store(server, next);
    return next.access;
  } catch {
    store(server, null);
    return null;
  }
}

/** Who the stored token names (the server's actor id), for display only. */
export function signedInAs(server: string): string | null {
  const t = load(server.replace(/\/$/, ""));
  const body = t?.access.split(".")[1];
  if (!body) return null;
  try {
    return (
      (
        JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as {
          sub?: string;
        }
      ).sub ?? null
    );
  } catch {
    return null;
  }
}

export function signOut(server: string): void {
  store(server.replace(/\/$/, ""), null);
}
