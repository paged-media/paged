# paged.server (Rust)

The optional remote for paged repositories (core ADR 180): a Cloudflare Worker,
one Durable Object per repository (SQLite: refs, evidence, commits, trees, small
blobs), and R2 for large blobs. The repository format and its governance are
core's `paged-repo` crate — the same code the editor runs in the browser.
The browser is complete without this server; this adds sync, sharing and (next)
an MCP endpoint. Concept: `../docs/concept.md`.

| Crate                 | What                                                                |
| --------------------- | ------------------------------------------------------------------- |
| `crates/paged-server` | the Worker + `RepoObject` Durable Object (wasm32, `worker` 0.8)     |
| `crates/paged-sync`   | a client: push (send only what the server lacks), pull, projections |

## HTTP (M1)

| Route                                |                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `POST /v1/r/{repo}/have`             | JSON `[address]` → the ones the server lacks                                         |
| `PUT /v1/r/{repo}/objects`           | a pack; every record checked against its address; large blobs to R2 before their row |
| `GET /v1/r/{repo}/refs`              | `{name: address}`                                                                    |
| `POST /v1/r/{repo}/refs/{name}`      | `{expected, new}`: compare-and-set through the kernel's governance                   |
| `GET /v1/r/{repo}/log/{ref}`         | first-parent history                                                                 |
| `GET /v1/r/{repo}/objects/{address}` | one object, immutable                                                                |
| `GET /v1/r/{repo}/file/{ref}`        | the `.paged` projection; `?history=1` carries the history                            |
| `GET /v1/r/{repo}/evidence`          | the evidence log                                                                     |

| `GET/POST /v1/r/{repo}/cr` | change requests: list, open `{source, target, title}` |
| `POST /v1/r/{repo}/cr/{id}/{approve,merge,close}` | approvals bind to the source head they saw; merge goes through the kernel |
| `POST /v1/r/{repo}/fetch` | `{want, have}` → one pack of what `want` adds (pull) |

Errors are RFC 9457 problem+json. A personal repository (`/v1/r/…`) is owned by its
first writer.

## Workspaces

`/v1/w/{ws}/r/{repo}/…` takes the same routes for a workspace's repository, which
obeys the workspace's policy and refuses everything when it cannot read one.

| Route                       |                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `POST /v1/w/{ws}`           | create; the caller is its owner                                                                                   |
| `GET /v1/w/{ws}/policy`     | `{seq, policy}`: roles (owner, editor, reviewer, viewer), agent autonomy, `main_merge_only`                       |
| `PUT /v1/w/{ws}/policy`     | `{expected_seq, policy}`: owner only, compare-and-set; a policy that does not parse or leaves no owner is refused |
| `GET /v1/w/{ws}/policy/log` | every version, each hash naming the one before                                                                    |

## Sign-in

paged.server is an OAuth 2.1 authorization server for its clients (an MCP client
such as Claude, the editor, the CLI) and delegates identity to any OpenID Connect
provider.

| Route                                         |                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata                                                            |
| `GET /.well-known/oauth-protected-resource`   | RFC 9728; a 401 names it in `WWW-Authenticate`                               |
| `POST /oauth/register`                        | RFC 7591 dynamic registration; public clients, https or loopback redirects   |
| `GET /oauth/authorize`                        | PKCE S256 only → the provider (code + PKCE + nonce) → `/oauth/callback`      |
| `POST /oauth/token`                           | `authorization_code` (one-time, PKCE-checked) and `refresh_token` (rotating) |

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

## MCP

`POST /mcp` is paged.server as an MCP server (Streamable HTTP: one JSON answer per
POST, no server-initiated stream; `GET` answers 405). The tools are core's
`paged-mcp` catalog, the same one `paged mcp` (stdio, native engine) offers.

- Sign-in: OAuth (a 401 names `/.well-known/oauth-protected-resource`). A service
  token also works.
- Every call is an agent's: `agent:<client>` acting for the signed-in person, in a
  run named by the `Mcp-Session-Id` the server hands out at `initialize`.
- Repositories check that person's role. The kernel confines the agent to
  `agent/<run>/…` refs at the default autonomy and records provenance on each of
  its versions. A model's change reaches `main` through `propose_change` and a
  person's approval.
- Store tools run here. Engine tools (`open_document`, `run_script`,
  `render_page`, `save_document`) act in the person's open editor tab, relayed
  through a Session Durable Object. `lookup_api` searches the embedded engine
  catalog. `download_link` mints a ten-minute signed URL (`/v1/dl/…`).
- Tools with a view declare `_meta.ui.resourceUri = ui://paged/view` (MCP Apps),
  served by `resources/read`.

## Keeping a repository

- **Sealed at rest.** R2 bytes are AES-256-GCM sealed under the repository's own key,
  with a nonce derived from the key and the object's address. One address is one
  plaintext, so a nonce never meets two. Objects written before keys existed are
  read in plain from `r/…`, still checked by address.
- **Collected.** `POST …/gc` (owner) removes what no ref reaches. An object
  recorded in the last hour (`PAGED_GC_GRACE_MS`) is kept, because a push uploads
  before it moves its ref. The maintenance alarm also collects, ten minutes after a
  ref moves (`PAGED_MAINTENANCE_DELAY_S`).
- **Snapshotted.** The same alarm writes a write-once snapshot of the refs and the
  evidence head to `b/<repo>/<ts>.json`.
- **Erased.** `DELETE /v1/r/{repo}` (owner) destroys the key first, so whatever R2
  still holds is unreadable from that moment. It then deletes the bytes, the rows
  and the directory entry. This is crypto-shredding: an erasure that fails halfway
  still erased.

## Headless engine

With no editor tab connected, engine tools run headless:

- One `EngineObject` per MCP run holds the run's working document, sealed in R2 under a
  per-run key, and calls `paged engine-serve`. The service is stateless: each call brings
  the document and takes back what the engine made of it.
- `open_document` reads the version's projection as the agent. `run_script` and
  `render_page` go through the engine. `save_document` commits the working copy as the
  agent's version on `agent/<run>/headless` (route `commit-file`), so `main` does not move.
- **Locally**, `PAGED_ENGINE_URL` names a `paged engine-serve --port 8793` (core's binary).
- **In production**, a Cloudflare Container runs `server/engine/Dockerfile`, attached to
  `EngineObject`, with `PAGED_ENGINE_CONTAINER=1`. Add to `wrangler.jsonc` at deploy time:

  ```jsonc
  "containers": [{ "class_name": "EngineObject", "image": "../../engine/Dockerfile", "image_build_context": "../../../../..", "max_instances": 4 }],
  "vars": { "PAGED_ENGINE_CONTAINER": "1" }
  ```

  The build context is the repository root (`image_build_context`): the Dockerfile copies
  `engine/core` from it. It is not in the local config, because `wrangler dev` would then need a Docker daemon.
  The image has not been built yet.

## Live relay

An editor tab connects so a model's engine tools act in it:

1. `POST /v1/live` (signed in) `{document, title}` → `{session, url}`, where `url`
   holds a one-minute signed ticket. A browser cannot put a bearer token on a
   WebSocket, so it trades one for the ticket.
2. `GET /v1/live/{session}/ws?ticket=…` upgrades to the tab's WebSocket, held by
   that tab's `SessionObject`. It hibernates, so an idle tab costs nothing.
3. A model's `run_script`, `render_page`, `open_document` and `save_document`
   reach the tab as `{type:"call", id, tool, args, agent, run}`. The tab answers
   `{type:"result", id, result}` once it has shown the call, and once the person
   has allowed it if the tab asks. Calls wait two minutes.
4. Only the tab's owner's model may call it. `list_live_sessions` lists the
   caller's own tabs, from their home directory.

## Local

```bash
cd crates/paged-server
printf 'PAGED_TOKENS={"%s":"user:dev"}\n' "$(printf %s dev-token | shasum -a 256 | cut -d' ' -f1)" > .dev.vars
npx wrangler dev --port 8791            # builds with worker-build; local workerd, R2 and DOs
cd ../.. && PAGED_SERVER_URL=http://127.0.0.1:8791 PAGED_REQUIRE_SERVER=1 \
  cargo nextest run --profile server --run-ignored only
```

The integration tests are `#[ignore = "server: …"]`: a plain `cargo test`
skips them, and an ignored run without `PAGED_SERVER_URL` reports
`unavailable: running server` (a failure under `PAGED_REQUIRE_SERVER=1`;
`docs/development/testing.md` at the repository root).

The tests also want `other-token` → `user:other` in `PAGED_TOKENS`, and for
`tests/oauth.rs` (which plays the identity provider on 127.0.0.1:8792):
`OIDC_ISSUER=http://127.0.0.1:8792`, `OIDC_CLIENT_ID=paged-dev`,
`OIDC_CLIENT_SECRET=fake-idp-secret` and a `PAGED_TOKEN_SECRET`.

Nothing here deploys. Creating the bucket and deploying are separate,
deliberate acts.

## Not yet

Nothing has been deployed. (`paged-repo` and `paged-mcp` are path dependencies on
`engine/core/crates/` in this repository, so the server always builds against the
engine at the same commit.)
