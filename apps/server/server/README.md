# paged.server (Rust)

The optional remote for paged repositories (core ADR 180): a Cloudflare Worker,
one Durable Object per repository (SQLite: refs, evidence, commits, trees, small
blobs), and R2 for large blobs. The repository format and its governance are
core's `paged-repo` crate — the same code the editor runs in the browser.
The browser is complete without this server; this adds sync, sharing and (next)
an MCP endpoint. Concept: `../docs/concept.md`.

| Crate | What |
|---|---|
| `crates/paged-server` | the Worker + `RepoObject` Durable Object (wasm32, `worker` 0.8) |
| `crates/paged-sync` | a client: push (send only what the server lacks), pull, projections |

## HTTP (M1)

| Route | |
|---|---|
| `POST /v1/r/{repo}/have` | JSON `[address]` → the ones the server lacks |
| `PUT /v1/r/{repo}/objects` | a pack; every record checked against its address; large blobs to R2 before their row |
| `GET /v1/r/{repo}/refs` | `{name: address}` |
| `POST /v1/r/{repo}/refs/{name}` | `{expected, new}`: compare-and-set through the kernel's governance |
| `GET /v1/r/{repo}/log/{ref}` | first-parent history |
| `GET /v1/r/{repo}/objects/{address}` | one object, immutable |
| `GET /v1/r/{repo}/file/{ref}` | the `.paged` projection; `?history=1` carries the history |
| `GET /v1/r/{repo}/evidence` | the evidence log |

Errors are RFC 9457 problem+json. The first writer of a repository owns it.

## Sign-in

paged.server is an OAuth 2.1 authorization server for its clients (an MCP client
such as Claude, the editor, the CLI) and delegates identity to any OpenID Connect
provider.

| Route | |
|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata |
| `GET /.well-known/oauth-protected-resource` | RFC 9728; a 401 names it in `WWW-Authenticate` |
| `POST /oauth/register` | RFC 7591 dynamic registration; public clients, https or loopback redirects |
| `GET /oauth/authorize` | PKCE S256 only → the provider (code + PKCE + nonce) → `/oauth/callback` |
| `POST /oauth/token` | `authorization_code` (one-time, PKCE-checked) and `refresh_token` (rotating) |

- Access tokens are HMAC-signed (`PAGED_TOKEN_SECRET`, ≥ 32 chars) and live an
  hour: checking one needs no lookup.
- Registered clients, pending logins, one-time codes and refresh tokens live in
  the `AuthObject` Durable Object, so a code or refresh token is spent exactly
  once.
- The provider's ID token comes from its token endpoint over TLS with our client
  secret (OIDC Core 3.1.3.7). So issuer, audience, expiry and nonce are checked,
  and there is no JWKS code. The actor is `user:<sub>@<issuer host>`.
- Configuration: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and the secrets
  `OIDC_CLIENT_SECRET` and `PAGED_TOKEN_SECRET`. Without them every sign-in
  route answers 503.
- Service tokens still work: the `PAGED_TOKENS` secret maps SHA-256(token) →
  actor id. With neither tokens nor sign-in configured, every request is refused.

## Local

```bash
cd crates/paged-server
printf 'PAGED_TOKENS={"%s":"user:dev"}\n' "$(printf %s dev-token | shasum -a 256 | cut -d' ' -f1)" > .dev.vars
npx wrangler dev --port 8791            # builds with worker-build; local workerd, R2 and DOs
cd ../.. && PAGED_SERVER_URL=http://127.0.0.1:8791 cargo test -p paged-sync
```

The tests also want `other-token` → `user:other` in `PAGED_TOKENS`, and for
`tests/oauth.rs` (which plays the identity provider on 127.0.0.1:8792):
`OIDC_ISSUER=http://127.0.0.1:8792`, `OIDC_CLIENT_ID=paged-dev`,
`OIDC_CLIENT_SECRET=fake-idp-secret` and a `PAGED_TOKEN_SECRET`.

Nothing here deploys. Creating the bucket and deploying are separate,
deliberate acts.

## Not yet

The Workspace DO (members,
roles, policy as governed data); change requests over HTTP; the MCP endpoint;
the Session DO relay to an open editor tab. `paged-repo` is a path dependency
into a sibling core checkout until core's `feat/paged-repo` is on origin.
