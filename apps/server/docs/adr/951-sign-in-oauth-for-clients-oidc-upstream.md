# ADR 951 — Sign-in: an OAuth 2.1 server for clients, OpenID Connect upstream

- **Status:** Accepted 2026-10-18.
- **Scope:** `server/crates/paged-server/src/{oauth,auth,auth_object,crypto}.rs`; the editor's
  `packages/repository/src/signin.ts`.

## Context

Three kinds of client sign in: a model client (Claude, through MCP), the browser editor, and
the CLI. The MCP authorization profile expects the server to be an OAuth 2.1 authorization
server with discovery and dynamic registration. Organisations bring their own identity
provider. The JavaScript OAuth provider for Workers cannot be used from a Rust Worker.

## Decision

1. paged.server is the **authorization server**:
   - RFC 8414 and RFC 9728 metadata; a 401 names the resource metadata.
   - RFC 7591 dynamic registration of public clients, with https or loopback redirects
     matched exactly.
   - PKCE S256 only, one-time codes, rotating refresh tokens.
2. **Identity comes from any OpenID Connect provider** (discovery; code + PKCE + nonce).
   - The ID token comes from the provider's token endpoint over TLS with our client
     secret, so (OIDC Core §3.1.3.7) issuer, audience, expiry and nonce are checked and the
     signature is not. There is no JWKS code.
   - The actor is `user:<sub>@<issuer host>`.
3. **Access tokens are HMAC-signed** and live an hour, so checking one needs no lookup.
   Clients, pending logins, codes and refresh tokens live in one Durable Object
   (`AuthObject`), so a code or a refresh token is spent exactly once.
4. **Service tokens** remain, as SHA-256 hashes in a secret. With neither configured, every
   request is refused.
5. **The browser editor** is a public client too, signing in through a popup. Its callback
   page answers over a same-origin `BroadcastChannel`, because the editor is
   cross-origin-isolated and its popup has no opener.

## Consequences

- Revoking an access token takes up to an hour; revoking a refresh token is immediate.
- The editor keeps its tokens in `localStorage`, readable by any script on its origin; the
  network wall (`connect-src`) limits where they can be sent.
