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

// A fake OpenID provider for the server specs: it signs in "alice" at once and
// checks its client secret and PKCE on the token call. Listens on 127.0.0.1:8792,
// the issuer the local paged.server's .dev.vars names.

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

const IDP = "127.0.0.1:8792";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** A provider that signs in "alice" at once and checks PKCE on the token call. */
export function fakeIdp(): Server {
  const codes = new Map<string, { nonce: string; challenge: string }>();
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${IDP}`);
    const json = (v: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer: `http://${IDP}`,
        authorization_endpoint: `http://${IDP}/authorize`,
        token_endpoint: `http://${IDP}/token`,
      });
    }
    if (url.pathname === "/authorize") {
      const code = `idp-${codes.size}`;
      codes.set(code, {
        nonce: url.searchParams.get("nonce")!,
        challenge: url.searchParams.get("code_challenge")!,
      });
      res.writeHead(302, {
        location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${url.searchParams.get("state")}`,
      });
      return res.end();
    }
    if (url.pathname === "/token") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const f = new URLSearchParams(body);
        const entry = codes.get(f.get("code") ?? "");
        const pkce =
          entry &&
          b64url(
            createHash("sha256")
              .update(f.get("code_verifier") ?? "")
              .digest(),
          ) === entry.challenge;
        if (!entry || !pkce || f.get("client_secret") !== "fake-idp-secret")
          return json({ error: "invalid_grant" }, 400);
        const claims = {
          iss: `http://${IDP}`,
          aud: f.get("client_id"),
          sub: "alice",
          exp: 4_000_000_000,
          nonce: entry.nonce,
        };
        json({
          id_token: `e30.${b64url(JSON.stringify(claims))}.unsigned`,
          token_type: "Bearer",
        });
      });
      return;
    }
    res.writeHead(404).end();
  });
}

export async function startFakeIdp(): Promise<Server> {
  const s = fakeIdp();
  await new Promise<void>((r) => s.listen(8792, "127.0.0.1", r));
  return s;
}
